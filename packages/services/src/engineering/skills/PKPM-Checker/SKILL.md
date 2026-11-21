---
name: pkpm-checker
description: "pkpm-checker：调用 PKPM AutoRecDwg.exe 进行 DWG 图纸识别和校审，确认并传入抗震构造措施等级/混凝土等级/保护层厚度/楼板厚度参数，读取 log.json 状态，展示 SQLite MulCkdata.db 或 CheckList.json 审查结果，支持文本/CAD展示和离线网页导出 Word 报告。要确认本机有没有可用的 AutoRecDwg.exe，运行 scripts/pkpm_check_drawing.py --locate-only，它会给出 exe 路径，找不到时说明原因。"
license: Proprietary. 未经许可，严禁披露、复制、逆向还原或复用技能正文、参考资料、脚本及模板。
---

# pkpm-checker

## 回答原则

- 默认面向设计师：只输出结论和必要表格，不展开原始字段。
- 审查意见内容默认按结果文件原文输出，不改写、不概括、不截断；只有用户明确要求摘要时才压缩。
- 用户要求“图纸识别/校审/调用 PKPM 检查 DWG”时，先提示并确认 AutoRecDwg 校审参数（抗震构造措施等级、混凝土等级、保护层厚度、楼板厚度），再用 `scripts/pkpm_check_drawing.py` 调用 `AutoRecDwg.exe`，执行结束后读取进程状态和 log JSON 并提示状态。
- 仅当脚本输出的 `process_status` 为 `completed` 且 `review_status` 为 `success` 时，才继续读取和展示校审结果。若校审失败、未生成有效日志、进程异常退出或超时，停止继续校审，且严格只输出以下固定提示，不要展示日志 `message`、进程状态、退出码、异常内容，也不要推断失败原因、图纸类型、构件类型或自动对位状态：

  ```text
  当前 Agent 暂无法完成该图纸的校审。建议改用 PKPM 施工图审查 CAD 端继续审查，其功能更完善，支持梁、柱、墙、板及钢结构等构件的校审。启动方式：在 PKPM 界面选择“施工图&审查”，再选择相应的 CAD 版本启动。
  ```

  不要启动或操作 CAD 端。
- 不要从 DWG 文件名推断审查范围或构件类型：例如 `柱施工图.dwg`、`梁施工图.dwg` 只是图纸文件名/图名，不代表用户只要审查柱或梁。默认始终审查整张图纸、展示所有构件和所有意见；只有用户明确说“只看柱/只看梁/只查某构件”时，才添加 `--component-name`、`--kind column/beam`、`--contains` 等过滤参数。图纸内实际包含哪些梁/柱/墙，应以 PKPM 输出的 JSON/DB 结果统计为准。
- 用户要求展示校审结果时，优先读取 CheckList JSON：若用户给了 `--json` 或 log 中有 `output_json`，默认使用 `scripts/pkpm_json_query.py` / `scripts/pkpm_json_cad.py`；只有用户明确指定 DB 或没有 JSON 时，才使用 `MulCkdata.db`。
- CAD 展示默认绘制到当前活动 AutoCAD 图纸；若用户给 DWG，CAD 脚本会先连接已运行 AutoCAD，未运行则通过 COM 启动；若目标图纸已打开，必须直接切换/激活该图纸，不再调用 `Documents.Open` 重复打开；未打开时才用 `Documents.Open(<dwg>)` 打开；打开前会取消当前未完成命令，兼容中文/空格路径，不用命令行 `OPEN` 传文件名。
- 导出 Word 报告时，直接用浏览器打开打包在 Skill 内的报告设计器网址，不要重新手写 Word 生成逻辑。
- 控制命令输出，减少 token：凡是“只为了执行动作/校验成功与否”的 Python 命令，不要把完整 stdout/stderr 读回对话；用临时日志接收输出，成功时只回显 `OK`，失败时只读取日志末尾 80 行。只有用户明确要求查看完整清单/明细时，才直接输出大量 markdown/json。

### 命令输出控制范式

PowerShell 中执行不需要读取输出的 Python 命令时，用下面模式：

```powershell
$log = Join-Path $env:TEMP "pkpm-checker_cmd.log"
python "<skill_dir>\scripts\some_script.py" <args> *> $log
if ($LASTEXITCODE -ne 0) {
  Get-Content -Path $log -Tail 80
  exit $LASTEXITCODE
}
"OK"
```

适用场景：`py_compile`、`quick_validate.py`、CAD 绘制命令、打开报告网页、只为生成/刷新文件的命令。  
不适用场景：用户要求查看审查意见表、规则表、构件表、错误详情时；此时仍应输出必要结果，但优先先跑 `summary`，再按用户需求查询明细，避免无条件 `reviews --limit 0` 打印超长清单。

## 1. 调用 exe 进行图纸识别和校审

将 `<skill_dir>` 替换为本 Skill 目录，`<drawing.dwg>` 替换为图纸路径，`<log.json>` 替换为日志 JSON 路径。图纸路径可带空格，脚本用参数数组调用 exe；调用时会把 exe 工作目录 `cwd` 设置为图纸所在文件夹，并把传给 exe 的图纸路径和日志路径转为绝对路径。不要因为 `<drawing.dwg>` 文件名含“柱”“梁”“墙”等字样就过滤审查对象；先完整校审整张 DWG，再按 JSON/DB 输出判断实际构件类型和意见。

### 1.1 AutoRecDwg 校审参数确认与解析

用户发起图纸识别/校审时，执行前必须先确认以下四个参数。若用户已经在本轮明确提供了四个参数，则解析后直接执行；否则按下面格式询问用户是否使用默认参数。若用户不使用默认值，只需要把需要修改的参数发给你，未提及的参数继续沿用默认值：

```text
是否使用以下参数进行校审？若不是，请把需要修改的参数发给我：
抗震构造措施等级：三级
混凝土等级：C30
保护层厚度：20mm
楼板厚度：100mm
```

收到用户确认，或收到用户给出的需要修改的参数后，将未修改项按默认值补齐，再由脚本参数解析为 AutoRecDwg 命令参数，无需向用户解释解析逻辑：

- 抗震构造措施等级：`特一级/一级/二级/三级/四级/非抗震` 分别传 `0/1/2/3/4/5`。
- 混凝土等级：`C` 可省略且不区分大小写；例如 `C30`、`c30`、`30` 都传 `30`，`C40`、`40` 都传 `40`。
- 保护层厚度：单位 `mm`，必须为大于 `0` 的整数；例如 `20mm` 传 `20`。
- 楼板厚度：单位 `mm`，必须为大于 `0` 的整数；例如 `100mm` 传 `100`。

`scripts/pkpm_check_drawing.py` 已内置上述解析。传给 Python 脚本的参数可以沿用用户原文（例如 `C30`、`20mm`），也可以传标准化后的数值（例如 `30`、`20`）；脚本最终传给 AutoRecDwg 的始终是不带单位的整数，并在调用 AutoRecDwg 时追加：

```text
-seismic <N> -concrete <N> -cover <N> -slab <N>
```

```powershell
# 自动定位 AutoRecDwg.exe 并执行：exe 第一个参数是图纸路径，第二个参数是日志路径
python "<skill_dir>\scripts\pkpm_check_drawing.py" "<drawing.dwg>" "<log.json>" --seismic "三级" --concrete "C30" --cover "20mm" --slab "100mm" --format markdown

# 用户指定软件目录、PKPMMain.exe/PKPM.exe 或 AutoRecDwg.exe 所在路径
python "<skill_dir>\scripts\pkpm_check_drawing.py" "<drawing.dwg>" "<log.json>" --software-dir "<PKPM软件目录>" --seismic "三级" --concrete "C30" --cover "20mm" --slab "100mm" --format markdown

# 用户直接指定 AutoRecDwg.exe
python "<skill_dir>\scripts\pkpm_check_drawing.py" "<drawing.dwg>" "<log.json>" --exe "<AutoRecDwg.exe>" --seismic "三级" --concrete "C30" --cover "20mm" --slab "100mm" --format markdown

# 只定位 exe 或只预览命令
python "<skill_dir>\scripts\pkpm_check_drawing.py" --locate-only --format markdown
python "<skill_dir>\scripts\pkpm_check_drawing.py" "<drawing.dwg>" "<log.json>" --seismic "三级" --concrete "C30" --cover "20mm" --slab "100mm" --dry-run --format markdown
```

log JSON 约定字段：

- `status`: `success` / `failure`
- `dwg`: 输入 DWG 图纸路径
- `output_db`: 成功时的详细 SQLite/MulCkdata.db 路径；失败时可为空
- `output_json`: 成功时的精简 CheckList.json 路径；失败时可为空
- `message`: 状态描述；校审失败时仅供程序判断，禁止对用户展示或据此推断失败原因。

执行完成后的默认提示：

- `success`：展示本次使用的校审参数、图纸张数、构件数量、审查意见数量，并列出 `output_db` / `output_json` 是否存在。
- `failure`：严格输出“回答原则”中的固定提示，不展示 log 中的 `message` 或任何失败原因。
- 进程状态：脚本在启动前会清除同路径的旧日志，避免将历史结果误判为本次结果。输出 `process_status=completed` 表示程序正常结束；`abnormal_exit` 表示程序异常退出，`timeout` 表示等待超时后已停止。JSON 同时提供 `returncode_hex` 以便记录 Windows 退出码。
- `process_status` 不是 `completed`，或 `review_status` 不是 `success` 时，`requires_cad_review=true`，并提供 `agent_message` 作为替代校审提示；此时不要继续读取或展示结果文件。
- 只有 `process_status=completed` 且 `review_status=success` 时脚本才返回 `0`；进程正常结束但校审失败或无有效日志时返回 `4`，异常退出时保留程序返回码，超时返回 `124`。

exe 自动定位逻辑：

1. 给了 `--exe` 就用它，给了 `--software-dir` 就在该目录/该 exe 对应的安装目录下找。
2. 都没给时，查注册表列出本机所有 PKPM 安装，按版本从高到低取第一个可用的。
3. 图纸校审需要 PKPM 2027.1.0 及以上版本，低版本的安装直接跳过。
4. `AutoRecDwg.exe` 位于 `<安装目录>\Ribbon\DRAWCK\ODA\AutoRecDwg.exe`。
5. 定位失败时脚本会说明原因（没装 / 版本太低 / 装了但没有校审模块），用 `--locate-only` 可列出所有试过的路径。

## 2. 审查结果文本展示

### 2.1 SQLite / MulCkdata.db

```powershell
# 所有项目、所有图纸：项目 / CutID / 图纸名称 / 类型 / 校审意见数量
python "<skill_dir>\scripts\mulckdata_query.py" --db "<MulCkdata.db>" projects --format markdown

# 单张图纸信息：图纸名称 / 类型 / 校审意见数量
python "<skill_dir>\scripts\mulckdata_query.py" --db "<MulCkdata.db>" drawing --cut-id 1 --format markdown

# 单张图纸全部审查意见：强条→应→宜→其他，同一规范相邻
python "<skill_dir>\scripts\mulckdata_query.py" --db "<MulCkdata.db>" reviews --cut-id 1 --limit 0 --sort spec --format markdown

# 按构件归组审查意见
python "<skill_dir>\scripts\mulckdata_query.py" --db "<MulCkdata.db>" reviews --cut-id 1 --limit 0 --sort component --format markdown

# 某类审查意见：strong / ying / yi / other
python "<skill_dir>\scripts\mulckdata_query.py" --db "<MulCkdata.db>" reviews --cut-id 1 --level strong --limit 0 --format markdown

# 某个构件的图纸级意见
python "<skill_dir>\scripts\mulckdata_query.py" --db "<MulCkdata.db>" reviews --cut-id 1 --component-name KZ01 --limit 0 --format markdown

# 图纸构件统计
python "<skill_dir>\scripts\mulckdata_query.py" --db "<MulCkdata.db>" components --cut-id 1 --kind all --format markdown

# 某个构件信息：构件名 / 尺寸 / PMID / 配筋 / 构件级意见数量 / 首条意见
python "<skill_dir>\scripts\mulckdata_query.py" --db "<MulCkdata.db>" components --cut-id 1 --kind column --component-name KZ01 --limit 1 --format markdown

# 某个构件图纸识别/配筋结果：跳过构件级意见，更快
python "<skill_dir>\scripts\mulckdata_query.py" --db "<MulCkdata.db>" components --cut-id 1 --kind column --component-name KZ01 --recognition-only --limit 1 --format markdown
```

SQLite 可展示清单：

- 项目/图纸清单：项目名、CutID、图纸名称、图纸类型、校审意见数量。
- 图纸基本信息：图纸名称、类型、外框/轮廓点、校审意见数量。
- 图纸级校审意见：类别、规范号、构件、意见内容原文、定位坐标。
- 审查意见排序/筛选：按规范、按构件、按原始顺序；按强条/应/宜/其他；按构件名精确或模糊匹配。
- 构件统计：梁/柱/全部构件数量。
- 构件明细：构件名、截面尺寸、PMID、配筋字符串、构件级意见数量、首条构件级意见。
- 梁/柱配筋展示：梁底筋合并、腰筋 G/N、柱按矩形/圆形/异形柱位置展示。
- CAD 展示：图纸外框、图纸标题、审查意见批注、指定类别/指定构件批注。

### 2.2 CheckList.json 精简结果

CheckList.json 的解析逻辑对齐 `report_designer.html`：合并 `rules`、按 `TopruleId` 或首个 `ruleIds` 定位条文，读取 `results[].summary` 构件统计，展开 `issues[].components` 为设计师可读意见明细。

```powershell
# 从 CheckList.json 展示项目/图纸/构件/意见汇总
python "<skill_dir>\scripts\pkpm_json_query.py" --json "<CheckList.json>" summary --format markdown

# 从 log.json 指向的 output_json 展示汇总
python "<skill_dir>\scripts\pkpm_json_query.py" --from-log "<log.json>" summary --format markdown

# 审查意见明细：图纸、构件、审查类别、条文性质、规范、条文、审查项目、内容、定位
python "<skill_dir>\scripts\pkpm_json_query.py" --json "<CheckList.json>" reviews --limit 0 --sort component --format markdown

# 按类别/条文性质/构件过滤
python "<skill_dir>\scripts\pkpm_json_query.py" --json "<CheckList.json>" reviews --check-type "规范审查" --severity "强" --limit 0 --format markdown
python "<skill_dir>\scripts\pkpm_json_query.py" --json "<CheckList.json>" reviews --component-name "KL5" --name-match contains --limit 0 --format markdown

# 审查条文/规则清单：规范、条文、条文性质、审查项目、通过/不通过/不涉及、意见数
python "<skill_dir>\scripts\pkpm_json_query.py" --json "<CheckList.json>" rules --format markdown

# 有审查意见的构件清单
python "<skill_dir>\scripts\pkpm_json_query.py" --json "<CheckList.json>" components --format markdown
```

JSON 可展示清单：

- 项目信息：工程名、软件版本、审查日期。
- 图纸汇总：按 JSON 原始 `results[]` 顺序逐张表格展示，不按同名图纸合并；展示图纸名称、构件数、已审构件数、梁/柱/墙构件数及已审数、意见组数量、审查意见数量；不展示未校审构件数。
- 支持的审查类别：来自 `SupportChecktype`，如规范审查、计算结果、配筋不足、配筋冗余、图模一致、图纸表达、重要提示。
- 审查意见明细：图纸、构件、部位、审查类别、条文性质、规范名称、条文编号、审查项目、意见内容、定位坐标。
- 审查条文/规则：规则 ID、审查类别、规范名称、条文编号、条文性质、审查项目、审查结果、意见数。
- 统计项：图纸张数、构件数、已审构件数、意见组数量、审查意见数量、强条/应/宜/其他数量、各审查类别数量。
- 筛选：按图纸、构件名、审查类别、条文性质、强条/应/宜/其他、全文包含过滤。

## 3. 审查结果 CAD 展示

CAD 批注统一默认：

- 图层：`PKPM_Check_Show_Mark`，不存在则创建。
- 字体样式：`PKPM_Check_Show_Text`，不存在则创建；默认 `FontFile=pkpmeng.shx`、`BigFontFile=pkpmchn.shx`、`Width/WidthFactor=0.7`、`ObliqueAngle=0`。
- 颜色：AutoCAD ACI `6`（洋红/品红）。
- COM 批注实体必须显式设置到上述图层和文字样式：脚本不仅创建图层/样式，还要在绘制前设置 `doc.ActiveLayer` / `doc.ActiveTextStyle`，并且对每个新建的 `Line`、`Circle`、`MText`、`Text`、`Polyline` 等对象逐个设置 `Layer`、`Color`、`StyleName/TextStyleName`。不能只创建图层/样式后让实体落在 CAD 当前图层。
- DWG 打开：传入 `--dwg` 时，先判断 AutoCAD 是否已运行、目标图纸是否已打开；已打开则只激活/切换到现有文档并返回，禁止再次 `Documents.Open`；未打开才通过 COM `Documents.Open` 打开。打开前会取消当前 AutoCAD 命令行里未完成的 `OPEN` 等命令，避免停在“输入要打开的图形文件名”提示。
- 坐标：SQLite/DB 批注坐标默认乘 `1000` 转 CAD 坐标；JSON 批注坐标不换算。
- 审查意见批注默认文字高度为 `50`、行距为 `70`；引出线方向由 CAD 脚本按构件定位计算，文字基线自动旋转到与引出线垂直；MText 固定为左上对正，并显式设置 `LineSpacingDistance=70`；引线长度按 `引出长度 + 额外100 + 行距 * 文本行数` 计算，并把引线终点作为文字左上锚点，让可见竖线覆盖整段文字高度再额外保留引出长度。
- 批注绘制方式不要在 SKILL 中固化描述；由 `scripts/mulckdata_cad.py` / `scripts/pkpm_json_cad.py` 的代码实现：先读取校审意见并解析 `MarkPoint` 等定位信息，按同一 `MarkPoint` 汇总意见文本，再通过 AutoCAD COM 创建线段、MText/Text 等实体绘制到 CAD。
- 同一 `MarkPoint` 的意见汇总由代码完成；可用 `--merge-tolerance` 调整同点判断容差。需要改变批注样式时，优先修改 CAD 脚本实现。

### SQLite CAD

```powershell
# 绘制图纸外框和标题
python "<skill_dir>\scripts\mulckdata_cad.py" --db "<MulCkdata.db>" --cut-id 1 drawing-frame

# 打开指定 DWG 后绘制图纸外框和标题
python "<skill_dir>\scripts\mulckdata_cad.py" --db "<MulCkdata.db>" --cut-id 1 --dwg "<drawing.dwg>" drawing-frame

# 绘制全部审查意见批注
python "<skill_dir>\scripts\mulckdata_cad.py" --db "<MulCkdata.db>" --cut-id 1 reviews --level all --sort spec

# 打开指定 DWG 后绘制全部审查意见批注
python "<skill_dir>\scripts\mulckdata_cad.py" --db "<MulCkdata.db>" --cut-id 1 --dwg "<drawing.dwg>" reviews --level all --sort spec

# 只绘制某类意见或某个构件意见
python "<skill_dir>\scripts\mulckdata_cad.py" --db "<MulCkdata.db>" --cut-id 1 reviews --level strong
python "<skill_dir>\scripts\mulckdata_cad.py" --db "<MulCkdata.db>" --cut-id 1 reviews --component-name KZ01
```

### JSON CAD

```powershell
# 在当前活动 CAD 图纸绘制 JSON 审查意见批注
python "<skill_dir>\scripts\pkpm_json_cad.py" --json "<CheckList.json>" reviews --sort component

# 从 log.json 指向的 output_json 绘制，并打开/切换到 DWG
python "<skill_dir>\scripts\pkpm_json_cad.py" --from-log "<log.json>" --dwg "<drawing.dwg>" reviews --sort component

# 只绘制某类或某构件
python "<skill_dir>\scripts\pkpm_json_cad.py" --json "<CheckList.json>" reviews --level strong
python "<skill_dir>\scripts\pkpm_json_cad.py" --json "<CheckList.json>" reviews --component-name KL5 --name-match contains

# 绘制 JSON 汇总文字
python "<skill_dir>\scripts\pkpm_json_cad.py" --json "<CheckList.json>" summary --x 0 --y 0
```

## 4. Word 报告导出

离线网页已打包到：

```text
<skill_dir>\assets\report_designer\report_designer.html
<skill_dir>\assets\report_designer\libs\
<skill_dir>\assets\report_designer\PKPM校审清单模板示例.docx
```

用户说“导出 Word 报告/生成 Word 报告/打开报告导出工具”时，默认直接打开浏览器进入报告设计器网址。所有默认参数都直接拼接到 `report_designer.html` 的 URL 查询参数中，不生成额外启动文件：

```powershell
# 直接打开报告设计器 URL，用户在网页中选择 CheckList.json 后导出 Word
python "<skill_dir>\scripts\open_report_designer.py"

# 设置一个或多个默认 JSON 路径；打开后自动读取并解析图纸
python "<skill_dir>\scripts\open_report_designer.py" --json "<CheckList-1.json>" --json "<CheckList-2.json>"
python "<skill_dir>\scripts\open_report_designer.py" --default-json-path "<CheckList-1.json>" --default-json-path "<CheckList-2.json>"

# 从 log.json 自动读取 output_json 后作为 jsonPath 拼到 URL
python "<skill_dir>\scripts\open_report_designer.py" --from-log "<log.json>" --project-name "<工程名称>"

# 自动填写基本信息、导出文件名或使用自定义模板；全部转为 URL 参数
python "<skill_dir>\scripts\open_report_designer.py" --json "<CheckList.json>" --project-name "<工程名称>" --output-name "<导出文件名>"
python "<skill_dir>\scripts\open_report_designer.py" --json "<CheckList.json>" --template "<template.docx>"

# 如需固定端口并手动打开网址
python "<skill_dir>\scripts\open_report_designer.py" --port 8765 --no-open
Start-Process "http://127.0.0.1:8765/report_designer.html?template=PKPM%E6%A0%A1%E5%AE%A1%E6%B8%85%E5%8D%95%E6%A8%A1%E6%9D%BF%E7%A4%BA%E4%BE%8B.docx"
```

该脚本会启动本地 `127.0.0.1` HTTP 服务。默认打开 `report_designer.html?template=PKPM校审清单模板示例.docx`；传入 `--json` / `--default-json-path` 多次时，会生成多个 `jsonPath=` URL 参数，网页打开后自动读取这些 JSON 并解析图纸。网页默认模板固定读取同目录的 `PKPM校审清单模板示例.docx`；导出时仅基于模板内容在内存中生成新 Word，不修改该模板文件。HTML 保留 `pkpmDesktopBridge` 以兼容打包 EXE；已不在 HTML 中传播报告输出路径字段。

## 读取链路

- 图纸识别校审：`pkpm_check_drawing.py -> cwd=<drawing.dwg所在文件夹> -> AutoRecDwg.exe <drawing.dwg绝对路径> <log.json绝对路径> -> read log.json -> output_db/output_json -> summary`。
- SQLite：`DwgInfo / DrawInfo / WpjInfo / SElesTable / CheckDataBeamTable / DrwDataBeamTable / CheckDataColTable / DrwDataColTable / CheckBaseDataTable`。
- JSON：`SupportChecktype / project / rules / results[].summary / results[].issues[].components`，解析逻辑对齐打包网页。
- Word：`open_report_designer.py -> 直接打开 report_designer.html URL -> libs/docxtemplater/pizzip/FileSaver -> PKPM校审清单模板示例.docx`。
- 详细 SQLite 字段含义见 `references/mulckdata-schema.md`；通常无需读取。
