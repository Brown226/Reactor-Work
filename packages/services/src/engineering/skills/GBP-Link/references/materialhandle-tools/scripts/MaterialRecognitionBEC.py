# skill_becs_cate_rename.py
"""
BECS构造cateName重命名Skill  (v3)

功能：
1. 读取原始 gen_mat2.py，注入类别映射字典
2. 在 cate 赋值位置增加映射替换逻辑，生成 gen_mat3.py
3. 备份原始输出json（文件名由 docx 主名 + 时间戳派生，绝不覆盖历史基线）
4. 调用 gen_mat3.py 解析 docx，生成新版材料json
5. 对比新旧版本差异，输出变更行、所有 cateName、构造热工信息

映射规则（改名称只需改 CATE_RENAME_MAP）：
    "屋面"       → "屋面主体层"
    "外墙"       → "填充墙"
    "楼梯间隔墙"  → "内墙填充墙"
    "楼板"       → "层间楼板"

v4 更新记录（提速与健壮性）：
- patch_gen_mat_script 增加幂等跳过：gen_mat3.py 已含 CATE_RENAME 注入且不旧于
  gen_mat2.py 时直接跳过读写（实测每次运行省 ~10ms 且避免反复覆写 Program Files 目录）。
- 解析核心 gen_mat2.py 同步升级（数值解析、材料表「数据来源」列、窗名三种拆分格式）。

v3 更新记录（支持斯维尔/Swell 报告）：
- gen_mat2.py 解析核心升级（两份 gen_mat2.py 已同步）：
  * 构造表跳过「考虑热桥后K=...」等公式行（缺失数值即跳过，不再 ValueError 崩溃）；
    表头兼容「材料名称（由上到下/由外到内）」「厚度δ」。
  * 表面热阻从 K 公式总阻值推导（K=1/(0.16+∑R) → RE+RI=0.16，夏季工况），不再硬断言 0.15。
  * 外窗表支持「太阳得热系数」列（斯维尔）与「自遮阳系数」列（BECS）两种表头；
    窗名称兼容 "12A钢铝单框双玻窗（平均）" 式无分隔命名，自动解析气体层与玻璃层数。
  * 工程材料表逐行防御解析，跳过单位行。
- 本脚本注入锚点（ANCHOR / CATE_LINE）在新版 gen_mat2.py 中保持不变，patch 幂等。

v2 更新记录：
1. 入口封装为 main() / _cli()，并用 _should_auto_run() 兼容三种运行方式：
   - 命令行：python skill_becs_cate_rename.py [work_dir] [docx_path] [out_txt_path]
   - python_executor 的 file_path 模式（该模式下 __name__ 为 None、__spec__ 为 None，
     原来的 if __name__ == "__main__" 不会触发；此模式下忽略 sys.argv，直接用默认参数，
     避免把会话里残留的 sys.argv 误当成本脚本参数）
   - import / importlib 加载后手动调用 main() 或链式调用类方法（不会自动运行）
2. 所有文本读取统一 newline=""，修复 diff_and_report 中"前8行预览"因 CRLF 被
   universal-newlines 归一化成 \n、split("\r\n") 只得到 1 个元素而打印整个文件的问题
3. 备份不再硬编码 "0.6_材料_v1_原类别.json"：改为 "<docx主名>_材料_原类别_<时间戳>.json"，
   重复运行不会用"已改名版"覆盖真基线；若检测到当前输出似乎已改名，会打印告警
4. 增加 precheck()：docx / gen_mat2.py / docx_parse.py 缺失时给出明确报错；
   patch 步骤对锚点缺失、重复注入做了防御
"""
import os
import sys
import time
import difflib
import re
import runpy


class BECSCateRenameSkill:
    # 类别映射配置，统一放这里，后续改名称只需要改这个字典
    CATE_RENAME_MAP = {
        "屋面": "屋面主体层",
        "外墙": "填充墙",
        "楼梯间隔墙": "内墙填充墙",
        "楼板": "层间楼板",
    }

    # patch 时定位用的锚点与目标代码行
    ANCHOR = 'OUT     = _sys.argv[3] if len(_sys.argv) > 3 else'
    CATE_LINE = '    if ct == "热桥柱": cate = "热桥柱"\n'
    APPLY_LINE = '    cate = CATE_RENAME.get(cate, cate)\n'

    def __init__(self, work_dir: str, docx_path: str, out_txt_path: str = None,
                 backup_dir: str = None, verbose: bool = True):
        """
        :param work_dir: 工作目录，存放 gen_mat2.py / gen_mat3.py / docx_parse.py 与备份文件
        :param docx_path: 输入 docx 路径，如 "D:/Downloads/BECS/0.6/0.6.docx"
        :param out_txt_path: 输出材料 json 路径；缺省为 docx 同目录下 "<主名>_材料.json"
        :param backup_dir: 备份目录，缺省与 work_dir 相同
        :param verbose: 是否打印过程信息
        """
        self.work_dir = work_dir
        self.docx_path = docx_path
        self.stem = os.path.splitext(os.path.basename(docx_path))[0]          # 例如 "0.6"
        self.out_txt_path = out_txt_path or os.path.join(
            os.path.dirname(docx_path), self.stem + "_材料.json")
        self.verbose = verbose

        self.gen_mat2_path = os.path.join(work_dir, "gen_mat2.py")
        self.gen_mat3_path = os.path.join(work_dir, "gen_mat3.py")
        self.docx_parse_path = os.path.join(work_dir, "docx_parse.py")
        # 备份名：docx 主名 + 时间戳，天然不覆盖历史基线
        self.backup_txt_path = os.path.join(
            backup_dir or work_dir,
            "%s_材料_原类别_%s.json" % (self.stem, time.strftime("%Y%m%d_%H%M%S")))
        self._backed_up = False

    # ------------------------------------------------------------------ 工具
    def _log(self, msg=""):
        if self.verbose:
            print(msg)
        return self

    @staticmethod
    def _read_text(path):
        """统一以 newline="" 读取，保留原始 CRLF，避免换行被归一化。
        编码自适应：先按 UTF-8，解码失败回退 GBK（materialhandle-tools 源目录输出为 ANSI/GBK）。"""
        try:
            with open(path, encoding="utf-8", newline="") as f:
                return f.read()
        except UnicodeDecodeError:
            with open(path, encoding="gbk", newline="") as f:
                return f.read()
    @staticmethod
    def _ensure_writable(path):
        """清除目标文件只读属性：PKPM Agent 安装目录(Program Files)下的文件常带 ReadOnly，
        Python open(...,"w") 会因权限拒绝而失败（PermissionError）。"""
        try:
            import stat as _stat
            if os.path.exists(path):
                os.chmod(path, os.stat(path).st_mode | _stat.S_IWRITE)
        except Exception:
            pass


    def precheck(self):
        """步骤0：依赖与输入检查"""
        missing = [p for p in (self.docx_path, self.gen_mat2_path, self.docx_parse_path)
                   if not os.path.exists(p)]
        if missing:
            raise FileNotFoundError("缺少必需文件：\n  " + "\n  ".join(missing))
        if not os.path.isdir(self.work_dir):
            raise NotADirectoryError("工作目录不存在：%s" % self.work_dir)
        self._log("✅ precheck 通过：docx / gen_mat2.py / docx_parse.py 均就位")
        self._log("   输入 docx : %s" % self.docx_path)
        self._log("   输出 json  : %s" % self.out_txt_path)
        self._log("   备份 json  : %s" % self.backup_txt_path)
        return self

    # ------------------------------------------------------------------ 步骤1
    def _gen_mat3_fresh(self):
        """gen_mat3.py 是否已含注入且不比 gen_mat2.py 旧（避免每次运行都重写派生脚本）。"""
        try:
            if not os.path.exists(self.gen_mat3_path):
                return False
            if os.path.getmtime(self.gen_mat3_path) < os.path.getmtime(self.gen_mat2_path):
                return False
            with open(self.gen_mat3_path, encoding="utf-8") as f:
                s = f.read()
            return "CATE_RENAME" in s and self.APPLY_LINE in s
        except Exception:
            return False

    def patch_gen_mat_script(self):
        """步骤1：读取 gen_mat2.py，注入 CATE_RENAME 字典 + 替换代码，生成 gen_mat3.py。
        提速（2026-09-20）：若 gen_mat3.py 已是最新注入版本（含 CATE_RENAME 且不旧于
        gen_mat2.py），直接跳过读写，避免每次运行都覆写派生脚本。"""
        if self._gen_mat3_fresh():
            self._log("gen_mat3.py 已是最新注入版本，跳过重新生成（如需强制刷新请删除 %s）"
                      % self.gen_mat3_path)
            return self
        with open(self.gen_mat2_path, encoding="utf-8") as f:
            s = f.read()

        if self.ANCHOR not in s:
            raise RuntimeError("gen_mat2.py 中未找到头部锚点：%r（文件可能已被改动）" % self.ANCHOR)
        if self.CATE_LINE not in s:
            raise RuntimeError("gen_mat2.py 中未找到目标代码行：%r" % self.CATE_LINE.strip())

        i = s.index(self.ANCHOR)
        line_end = s.index("\n", i) + 1

        map_lines = ['    "%s": "%s",' % (k, v) for k, v in self.CATE_RENAME_MAP.items()]
        rename_def = ("\n# cateName 重命名（BECS Skill）\nCATE_RENAME = {\n"
                      + "\n".join(map_lines) + "\n}\n")

        if "CATE_RENAME" in s:
            self._log("⚠️ gen_mat2.py 中已存在 CATE_RENAME，跳过字典注入，仅确保映射调用存在")
        else:
            s = s[:line_end] + rename_def + s[line_end:]

        if self.APPLY_LINE in s:
            self._log("⚠️ 映射调用已存在，不重复注入")
        else:
            s = s.replace(self.CATE_LINE, self.CATE_LINE + self.APPLY_LINE)

        self._ensure_writable(self.gen_mat3_path)
        with open(self.gen_mat3_path, "w", encoding="utf-8") as f:
            f.write(s)
        self._log("\n✅ gen_mat3.py 已生成：%s（%d 字符 / %d 字节）"
                  % (self.gen_mat3_path, len(s), os.path.getsize(self.gen_mat3_path)))

        j = s.index("CATE_RENAME.get")
        self._log("\n==== 注入代码片段 ====")
        self._log(s[j - 320:j + 120])
        return self

    # ------------------------------------------------------------------ 步骤2
    def backup_old_output(self):
        """步骤2：备份当前旧版材料 txt（时间戳命名，不覆盖历史备份）"""
        if not os.path.exists(self.out_txt_path):
            self._log("\n⚠️ 输出文件尚不存在，跳过备份：%s（本次为首次生成，diff 步骤将只做单版本报告）"
                      % self.out_txt_path)
            self._backed_up = False
            return self

        with open(self.out_txt_path, "rb") as f:
            prev_data = f.read()

        # 重复运行检测：当前输出里若已出现"改名后"的类别，说明基线可能已被上一次运行改过
        try:
            try:
                prev_txt = prev_data.decode("utf-8")
            except UnicodeDecodeError:
                prev_txt = prev_data.decode("gbk")
            cates = set(re.findall(r'"cateName":?\s*"([^"]+)"', prev_txt))
            already = sorted(cates & set(self.CATE_RENAME_MAP.values()))
            if already:
                self._log("\n⚠️ 当前输出中已存在改名后的类别 %s，说明它可能已是上一次运行的结果；"
                          "\n   继续备份并重新生成，但新旧 diff 可能为空。若需真实基线，"
                          "请先用历史备份回滚 %s" % (already, self.out_txt_path))
        except UnicodeDecodeError:
            pass

        with open(self.backup_txt_path, "wb") as f:
            f.write(prev_data)
        self._backed_up = True
        self._log("\n✅ 原始文件已备份到：%s（%d 字节）" % (self.backup_txt_path, len(prev_data)))
        return self

    # ------------------------------------------------------------------ 步骤3
    def run_gen_mat3(self):
        """步骤3：调用 gen_mat3.py，解析 docx 生成新版材料 json"""
        if not os.path.exists(self.gen_mat3_path):
            raise FileNotFoundError("gen_mat3.py 不存在，请先执行 patch_gen_mat_script()")
        old_argv = sys.argv
        try:
            sys.argv = ["gen_mat3.py", self.work_dir, self.docx_path, self.out_txt_path]
            runpy.run_path(self.gen_mat3_path, run_name="__main__")
        finally:
            sys.argv = old_argv          # 还原，避免污染会话中其它脚本对 sys.argv 的依赖
        self._log("\n✅ gen_mat3.py 执行完成，已输出新版材料 txt：%s" % self.out_txt_path)
        return self

    # ------------------------------------------------------------------ 步骤4
    def diff_and_report(self):
        """步骤4：差异对比 + cateName 列表 + 文件信息 + 构造热工参数报表"""
        new_txt = self._read_text(self.out_txt_path)

        # ---- 与备份做 diff
        if self._backed_up and os.path.exists(self.backup_txt_path):
            old_txt = self._read_text(self.backup_txt_path)
            diff_lines = [
                x for x in difflib.unified_diff(
                    old_txt.splitlines(), new_txt.splitlines(),
                    "上一版", "新版", lineterm="", n=0)
                if x.startswith(("+", "-")) and not x.startswith(("+++", "---"))
            ]
            self._log("\n==== 文本差异：共 %d 行 ====" % len(diff_lines))
            for line in diff_lines:
                self._log("   " + line.strip())
            if not diff_lines:
                self._log("   （新旧版本内容完全一致，无 cateName 之外的改动）")
            else:
                only_cate = all('"cateName"' in x for x in diff_lines)
                self._log("   差异是否全部集中在 cateName 行：%s" % ("是" if only_cate else "否"))
        else:
            self._log("\n==== 文本差异：无可用基线备份，跳过 diff ====")

        # ---- 所有 cateName
        self._log("\n==== 新版全部 cateName ====")
        for m in re.finditer(r'"cateName":?\s*"([^"]+)"', new_txt):
            self._log("  - " + m.group(1))

        # ---- 文件信息（二进制统计，换行按字节数）
        raw_bin = open(self.out_txt_path, "rb").read()
        crlf = raw_bin.count(b"\r\n")
        self._log("\n==== 文件信息 ====")
        self._log("磁盘字节数: %d" % len(raw_bin))
        self._log("CRLF换行数量: %d" % crlf)
        self._log("LF裸换行数量: %d" % (raw_bin.count(b"\n") - crlf))
        self._log("文本行数: %d" % len(new_txt.splitlines()))

        # ---- 构造热工参数（跳过外窗、户门、外门）
        self._log("\n=== 新版 struct 各构造 cateName / name / K / RT / D ===")
        pattern = re.compile(
            r'"cateName":\s*"([^"]+)".*?"name":\s*"([^"]+)".*?"dataK":\s*([\d.]+)'
            r'.*?"dataRT":\s*([\d.]+).*?"dataDrs":\s*([\d.]+)', re.S)
        for m in pattern.finditer(new_txt):
            c, n, k, rt, dd = m.groups()
            if c in ("外窗", "户门", "外门"):
                continue
            self._log("  %-10s| %-14s| K=%.4f RT=%.4f D=%.4f"
                      % (c, n, float(k), float(rt), float(dd)))

        # ---- 前8行预览（newline="" 读取，CRLF 保留，splitlines 才是真·逐行）
        self._log("\n=== 前8行预览 ===")
        self._log("\n".join(new_txt.splitlines()[:8]))
        return self

    # ------------------------------------------------------------------ 一键跑
    def run_all(self):
        return (self.precheck()
                    .patch_gen_mat_script()
                    .backup_old_output()
                    .run_gen_mat3()
                    .diff_and_report())


# ========== 默认参数（可被命令行 / main() 入参覆盖）==========
DEFAULT_WORKDIR = r"C:\Users\LinLin\Documents\PKPMAgent\01a08a42-3496-7b52-b4a1-14cdcff4bb06"
DEFAULT_DOCX = r"D:\Downloads\BECS\0.6\0.6.docx"
DEFAULT_OUT_TXT = r"D:\Downloads\BECS\0.6\0.6_材料.json"


def main(work_dir=None, docx_path=None, out_txt_path=None, verbose=True):
    """函数式入口：import 后直接 main() 即可，无需关心 __name__"""
    skill = BECSCateRenameSkill(
        work_dir=work_dir or DEFAULT_WORKDIR,
        docx_path=docx_path or DEFAULT_DOCX,
        out_txt_path=out_txt_path or DEFAULT_OUT_TXT,
        verbose=verbose)
    return skill.run_all()


def _cli(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="BECS 构造 cateName 重命名（解析 docx → 生成材料 txt）")
    ap.add_argument("work_dir", nargs="?", default=DEFAULT_WORKDIR, help="工作目录（存放 gen_mat2/3.py、docx_parse.py、备份）")
    ap.add_argument("docx_path", nargs="?", default=DEFAULT_DOCX, help="输入 BECS 报告书 docx")
    ap.add_argument("out_txt_path", nargs="?", default=DEFAULT_OUT_TXT, help="输出材料 json")
    ap.add_argument("-q", "--quiet", action="store_true", help="只打印关键结论")
    a = ap.parse_args(argv)
    return main(a.work_dir, a.docx_path, a.out_txt_path, verbose=not a.quiet)


def _should_auto_run():
    """判断当前是否应自动执行入口：
    - 常规脚本运行：__name__ == "__main__"
    - python_executor 的 file_path 模式：__name__ 为 None、__spec__ 为 None、__file__ 有值
    - import / importlib.exec_module：__name__ 为模块名且 __spec__ 非空 → 不自动运行
    """
    g = globals()
    nm = g.get("__name__")
    if nm == "__main__":
        return True
    if nm is None and g.get("__spec__") is None and g.get("__file__"):
        return True
    return False


if _should_auto_run():
    # file_path 模式下 sys.argv 可能是会话里其它脚本残留的，故只在真正的 __main__ 下才吃命令行参数
    _argv = sys.argv[1:] if globals().get("__name__") == "__main__" else []
    _cli(_argv)
