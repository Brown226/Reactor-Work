"""Reactor 管理台「用量与额度」视觉验收（额度分配 QTM）。

对**真实运行**的身份服务（127.0.0.1:8791/console）做 GUI 走查：
登录 → 进入「用量与额度」→ 核对额度分配面板/告警区/对账 tab → 建一条 5M 规则
→ 看列表/编辑回填 → 删掉 → 批量分配对话框（dryRun 预览 + 零写入应用）。全程截图留证。

跑法：python scripts/quota-admin-walkthrough.py
"""
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8791/console/"  # 必须带尾斜杠：/console 是 302，无斜杠时 SPA 不加载（实测）
SHOT_DIR = "shots"

passed, failed = 0, 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ✓ {name}")
    else:
        failed += 1
        print(f"  ✗ {name} {detail}")


def main():
    import os
    os.makedirs(SHOT_DIR, exist_ok=True)
    # 复用系统 Chrome/Edge（本机未装 playwright 自带 chromium）
    exe = None
    for cand in (
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    ):
        if os.path.exists(cand):
            exe = cand
            break
    if exe is None:
        print("SKIP: 找不到可用的 Chrome/Edge")
        sys.exit(0)
    print(f"  ℹ 使用浏览器：{exe}")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=exe, args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1600, "height": 1000})
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        # ── 登录 ──────────────────────────────────────────────────────
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_timeout(800)
        page.screenshot(path=f"{SHOT_DIR}/01-login.png")
        # 登录表单（实测 DOM：#login-username / #login-password / 按钮「登 录」）
        page.fill("#login-username", "admin")
        page.fill("#login-password", "Admin@123")
        page.screenshot(path=f"{SHOT_DIR}/02-login-filled.png")
        page.get_by_role("button", name="登 录").click()
        page.wait_for_timeout(2500)
        page.screenshot(path=f"{SHOT_DIR}/03-after-login.png")
        check("登录后进入管理台（不再是登录页）", "login" not in page.url.lower(), page.url)

        # ── 进入「用量与额度」 ─────────────────────────────────────────
        page.goto(f"{BASE}usage", wait_until="networkidle")
        page.wait_for_timeout(1500)
        page.screenshot(path=f"{SHOT_DIR}/04-usage-page.png", full_page=True)

        body = page.inner_text("body")
        check("页面标题为「用量与额度」", "用量与额度" in body)
        # 额度分配面板（P4a）
        check("有「额度分配」面板", "额度分配" in body)
        check("面板说明提到三类规则/账本口径", ("组织" in body and "部门" in body and "用户" in body) or "账本" in body)
        # 空态 / 合成项 / 已有规则：三者任一都说明面板正常渲染（不假设起点一定是空库）
        has_empty = "未配置任何额度" in body
        has_synth = "来自旧配置" in body
        has_rule = page.get_by_role("button", name="编辑").count() > 0
        check("额度列表正常渲染（空态/合成项/已有规则 任一）", has_empty or has_synth or has_rule,
              f"empty={has_empty} synth={has_synth} rules={has_rule}")

        # 对账面板（P1c）
        check("有「计量对账」面板", "计量对账" in body)

        # ── 预清理：删掉本脚本上次可能残留的 org 规则（保证起点干净） ──
        # 为什么需要：上一版跑完没删干净，导致下一次把残留当成本次结果而误报。
        for r in page.locator("div", has_text="组织").filter(has_text="5000K").all():
            try:
                r.get_by_role("button", name="删除").first.click(timeout=2000)
                page.wait_for_timeout(800)
            except Exception:
                pass
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(1200)

        # ── 新建额度：5M ──────────────────────────────────────────────
        page.get_by_role("button", name="新建额度").click()
        page.wait_for_timeout(600)
        page.screenshot(path=f"{SHOT_DIR}/05-new-quota-dialog.png")
        check("弹出「额度规则」对话框", "额度规则" in page.inner_text("body"))

        # 维度选「部门」，看部门下拉
        page.select_option("#q-scope", "dept")
        page.wait_for_timeout(400)
        dept_count = page.locator("#q-dept option").count()
        check("部门维度出现部门下拉且有选项", dept_count > 1, f"options={dept_count}")
        # 换回组织
        page.select_option("#q-scope", "org")
        page.wait_for_timeout(300)

        # 输入 5M → 应有实时换算预览
        page.fill("#q-limit", "5M")
        page.wait_for_timeout(400)
        preview = page.inner_text("body")
        check("★输入 5M 显示换算预览「= 5,000,000 tokens」", "5,000,000" in preview, preview[:0])
        page.screenshot(path=f"{SHOT_DIR}/06-unit-preview.png")

        # 非法输入 → 红字提示
        page.fill("#q-limit", "5MB")
        page.wait_for_timeout(300)
        bad = page.inner_text("body")
        check("★非法输入 5MB 给出红字提示", "无法识别" in bad)
        page.fill("#q-limit", "5M")
        page.wait_for_timeout(300)

        # 阈值与动作
        page.fill("#q-th", "80, 100")
        page.select_option("#q-action", "warn")
        page.screenshot(path=f"{SHOT_DIR}/07-dialog-ready.png")
        page.get_by_role("button", name="保存").click()
        page.wait_for_timeout(2000)
        page.screenshot(path=f"{SHOT_DIR}/08-after-save.png", full_page=True)

        # ★断言只认**本脚本建的那条**（列表里若有别的规则/残留，不能算我失败，
        #   也不能让我误判渲染 bug —— 上一版就因为把残留当成本次结果而误报）
        body2 = page.inner_text("body")
        # 新布局的规则行是「0 / 5000K · 0%」（不带 "tokens" 后缀），故按数字片段匹配
        check("★保存后列表出现组织额度 5000K（5M 归一化展示）", "5000K" in body2, body2[:200])
        check("该条徽标为「仅告警」（warn 不用 danger 红，避免误以为会拦调用）", "仅告警" in body2)
        check("合成项消失（已落库为正式规则）", "来自旧配置" not in body2)
        # 新布局：每条规则带「已用/上限」进度数字（核心改进）
        check("★规则行显示当期用量（已用 / 上限）", "/ 5000K" in body2 or "/ 5,000,000" in body2, body2[:200])
        # 新布局：紧凑概览替代 4 张大卡
        check("★本期概览为紧凑一行（不再是 4 张大卡）", "本期概览" in body2)

        # 版面顺序：额度分配 应早于 本期概览 与 报表（配置/主任务优先）
        i_quota = body2.find("额度分配")
        i_over = body2.find("本期概览")
        i_table = body2.find("占比 (tokens)") if "占比 (tokens)" in body2 else body2.find("占比（总 tokens）")
        check(
            "★版面顺序：额度分配 → 本期概览 → 报表（主任务置顶）",
            0 <= i_quota < i_over < (i_table if i_table >= 0 else 10 ** 9),
            f"quota={i_quota} overview={i_over} table={i_table}",
        )
        page.screenshot(path=f"{SHOT_DIR}/08-after-save.png", full_page=True)

        # ── 编辑回填 ──────────────────────────────────────────────────
        # 只点**组织那条**的编辑（按行定位，避免点到别的规则）
        org_row = page.locator("div", has_text="组织").filter(has_text="5000K").last
        edit_btn = org_row.get_by_role("button", name="编辑")
        if edit_btn.count() > 0:
            edit_btn.first.click()
            page.wait_for_timeout(600)
            val = page.input_value("#q-limit")
            check("★编辑回填为归一化值（5000000）", val == "5000000", val)
            page.screenshot(path=f"{SHOT_DIR}/09-edit-refill.png")
            page.get_by_role("button", name="取消").click()
            page.wait_for_timeout(400)

        # ── 对账（折叠区，需先展开） ────────────────────────────────────
        page.get_by_text("计量对账").first.click()
        page.wait_for_timeout(500)
        page.get_by_role("button", name="拉取").first.click()
        page.wait_for_timeout(2500)
        page.screenshot(path=f"{SHOT_DIR}/10-reconciliation.png", full_page=True)
        rbody = page.inner_text("body")
        check("对账表渲染出表头", "账本调用" in rbody and "上报调用" in rbody)

        # ── 删除规则（只删本脚本建的 org 5M 那条，不动现场其它规则） ────
        org_row_del = page.locator("div", has_text="组织").filter(has_text="5000K").last
        del_btn = org_row_del.get_by_role("button", name="删除")
        if del_btn.count() > 0:
            del_btn.first.click()
            page.wait_for_timeout(1500)
            body3 = page.inner_text("body")
            check("★删除后本脚本的 5000K 组织额度消失", "5000K" not in body3)
            page.screenshot(path=f"{SHOT_DIR}/11-after-delete.png", full_page=True)

        # ── 批量分配（§11.7） ─────────────────────────────────────────
        # 安全边界：**不向真实部门/真实用户写规则**。GUI 只验证交互与 dryRun 预览
        # （dryRun 不写库）；应用路径用一个不存在的 uid，结果是"写入 0 条 + 跳过 1 条"。
        # 写入语义（同值下发/覆盖/幂等/跳过理由）由冒烟 ⑫ 段 25 条断言覆盖。
        page.get_by_role("button", name="批量分配").click()
        page.wait_for_timeout(700)
        page.screenshot(path=f"{SHOT_DIR}/12-batch-dialog.png")
        check("弹出「批量分配额度」对话框", "批量分配额度" in page.inner_text("body"))

        # 默认对象 = 部门下每个用户 ⇒ 出现部门下拉且有真实部门
        b_dept_count = page.locator("#b-dept option").count()
        check("批量对话框出现部门下拉且有选项", b_dept_count > 1, f"options={b_dept_count}")

        # 上限 100M ⇒ 换算预览（与单条对话框同口径）
        page.fill("#b-limit", "100M")
        page.wait_for_timeout(400)
        check("★批量上限 100M 显示换算预览「= 100,000,000 tokens」", "100,000,000" in page.inner_text("body"))
        page.screenshot(path=f"{SHOT_DIR}/13-batch-unit-preview.png")

        # 非法输入同样红字提示
        page.fill("#b-limit", "5MB")
        page.wait_for_timeout(300)
        check("★批量上限非法输入 5MB 给出红字提示", "无法识别" in page.inner_text("body"))
        page.fill("#b-limit", "100M")
        page.wait_for_timeout(300)

        # 选中根部门（全公司 800+ 人）⇒ dryRun 预览会被 500 目标上限守卫挡下。
        # 这里断言的是**界面给出明确报错**而不是静默无反馈 —— 管理员必须知道为什么没预览。
        # 对应的 400 是预期响应，末尾的控制台检查据此豁免（见 cap_guard_seen）。
        cap_guard_seen = False
        if b_dept_count > 1:
            page.select_option("#b-dept", index=1)
            page.wait_for_timeout(1500)
            cap_guard_seen = "单次最多批量" in page.inner_text("body")
            check("★选超限部门时预览明确报错（500 目标上限，不静默）", cap_guard_seen)
        page.screenshot(path=f"{SHOT_DIR}/14-batch-dept-selected.png")

        # 切到「指定用户」⇒ 出现 uid 多行输入；填一个不存在的 uid ⇒ 预览说明跳过理由
        page.select_option("#b-mode", "users")
        page.wait_for_timeout(400)
        check("指定用户维度出现 uid 多行输入", page.locator("#b-uids").count() == 1)
        page.fill("#b-uids", "walkthrough-ghost-user")
        page.wait_for_timeout(600)
        # uid 列表改动不自动预览（防粘贴几百个 uid 时每敲一键发一次请求）⇒ 手动点「预览」
        page.get_by_role("button", name="预览").click()
        page.wait_for_timeout(1500)
        preview_text = page.inner_text("body")
        check("★dryRun 预览给出分维度计数（将写入 0 条）", "将写入 0 条" in preview_text, preview_text[:200])
        check("★预览说明不存在的 uid 会被跳过（不静默建规则）", "用户不存在" in preview_text)
        page.screenshot(path=f"{SHOT_DIR}/15-batch-skipped-preview.png")

        # 应用：写入 0 条 + 跳过 1 条（对真实库零写入）
        # 注意：不能数背景里的「编辑」按钮 —— Radix 对话框打开时会把背景设为
        # aria-hidden，Playwright 的 role 选择器数不到它，计数变化与是否写入无关。
        # 这里断言"ghost uid 从未变成规则"（页面上不出现该 uid 行）。
        page.get_by_role("button", name="应用").click()
        page.wait_for_timeout(2500)
        after_text = page.inner_text("body")
        check("★应用回执「已写入 0 条规则」并提示跳过 1 条", "已写入 0 条规则" in after_text and "跳过 1 条" in after_text, after_text[:200])
        page.screenshot(path=f"{SHOT_DIR}/16-batch-applied.png", full_page=True)
        check("批量对话框已关闭", "批量分配额度" not in page.inner_text("body"))
        check("★对真实库零写入（ghost uid 未变成规则）", "walkthrough-ghost-user" not in page.inner_text("body"))

        # 控制台无报错（401 是登录前并发探测的正常响应，不算 JS 错误；
        # 400 仅在上面的"超限部门预览"断言成立时豁免 —— 那是预期响应，不是故障）
        real_errors = [
            e for e in errors
            if "favicon" not in e.lower() and "401" not in e and "Unauthorized" not in e
            and not (cap_guard_seen and "400 (Bad Request)" in e)
        ]
        check("浏览器控制台无 JS 错误", len(real_errors) == 0, real_errors[:3])

        browser.close()

    print(f"\n视觉验收：通过 {passed} / 失败 {failed}")
    sys.exit(0 if failed == 0 else 1)


main()
