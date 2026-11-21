---
name: rhino-link
description: |
  操控 Rhino 完成建模、绘图、曲面、网格、标注等 3D 建模任务。本技能配套了完整的 Rhino API 检索机制,按"模块 → 函数"渐进查询;通过 Python COM 接口编写脚本操控 Rhino，所有操作代码直接在 python_executor 中运行。
  触发条件:
  1. 用户提到 Rhino、犀牛、3D 建模等关键词时触发
  2. 用户需要创建曲面、NURBS 曲线、网格、布尔运算等 Rhino 专属操作时触发
  3. 用户提到 BIM 参数化建模、建筑形体生成等需要 3D 建模能力的任务时触发
  4. 即使用户没有明确说 "Rhino",只要涉及 3D 几何体创建、曲面造型,也应考虑触发此技能
license: Proprietary. 未经许可，严禁披露、复制、逆向还原或复用技能正文、参考资料、脚本及模板。
---

# Rhino COM 操作技能

通过 Python COM 接口操控 Rhino 8 / 7 / 6 完成建模、查询和数据交互。RhinoScript 共 1245 个 API 已结构化至 `references/rhinoscript_api.db`,通过 `scripts/` 下的脚本渐进式检索。

## 1. 连接 Rhino(强制要求)

为了确保连接成功,必须使用预定义的 `get_rhino` 获取 Rhino 实例和 RhinoScript 接口。**绝对禁止**直接调用 `win32com.client.Dispatch("Rhino.Interface")` 或自己用 `comtypes` 拼连接代码 —— 已封装的 `get_rhino` 处理了版本探测、typelib 加载、IRhinoScript 强类型转换、窗口可见性等所有坑点。

```python
from PKPMAgent.software_link_kit.rhino import get_rhino, to_nested_variant_r8, to_nested_variant_i4, to_flat_variant_r8, to_flat_variant_i4, rgb # 辅助函数见第3节

result = get_rhino()
if isinstance(result, str):
    print(result)  # 打印错误信息(未安装 Rhino / typelib 加载失败 / COM 连接失败 等)
else:
    rhino, script, version = result  # rhino: IRhinoInterface; script: IRhinoScript; version: int (如 8)
```

返回值约定:
- 成功:`(rhino, script, version)` 元组,version 为整数(如 8)
- 失败:错误描述字符串

要点:
- `get_rhino()` 自动检测已运行的 Rhino 进程并复用,没有则按注册表里最高版本启动新实例。
- `rhino`(IRhinoInterface):Rhino 应用本身的属性(Visible / BringToTop 等),`get_rhino()` 已设置好,一般不需要再碰。
- `script`(IRhinoScript):绑定了绝大部分 RhinoScript API,日常建模全部走 `script.Method()`。
- `get_rhino()` 有一定的时间开销，请利用 `python_executor` 工具的环境持久化与变量共享特性，复用 rhino, script, version 变量。
- 少数模块(Layer_State_Methods / Named_Position_Methods)属于插件,需先获取插件对象再调用:
  ```python
  plugin = script.GetPlugInObject("Rhino Bonus Tools")  # 或 "Named Position"
  plugin.SomeMethod(...)
  ```

## 2. RhinoScript API 渐进式检索

**重要**:不要凭印象写函数签名。RhinoScript 大量方法的参数顺序、类型、单位(度/弧度)反直觉,几乎所有"嵌套数组"或"颜色"的方法都有 marshalling 陷阱。完整 API 文档已经结构化进 `references/rhinoscript_api.db`,**写代码前先查 db**。

### Step 1:确定模块

```bash
python scripts/list_top_modules.py #列出所有模块
```

28 个模块概览:

| 模块 | 用途 |
|---|---|
| Curve_Methods | 曲线创建与编辑 |
| Surface_and_Polysurface_Methods | 曲面 / 多曲面(含 AddBox / AddCone / AddSphere / 布尔等) |
| Mesh_Methods | 网格 |
| Object_Methods | 对象通用属性与操作(查询、名称、图层归属、移动、复制、删除等) |
| Selection_Methods | 选择与遍历 |
| Layer_Methods | 图层管理 |
| Layer_State_Methods | 图层状态保存/恢复(需先 `GetPlugInObject("Rhino Bonus Tools")`) |
| Dimension_Methods | 标注 |
| Geometry_Methods | 杂项几何工具 |
| Light_Methods | 灯光 |
| Material_Methods | 渲染材质 |
| Block_Methods | 块 |
| Group_Methods | 分组 |
| Hatch_Methods | 填充图案 |
| Linetype_Methods | 线型 |
| Named_Position_Methods | 命名位置(需先 `GetPlugInObject("Named Position")`) |
| Object_Grip_Methods | 控制点编辑 |
| Point_and_Vector_Methods | 点与向量运算 |
| Line_and_Plane_Methods | 直线、平面工具 |
| Transformation_Methods | 4×4 变换矩阵 |
| User_Data_Methods | 用户数据存取 |
| User_Interface_Methods | 用户交互(取值/对话框) ⚠️ 全模块交互阻塞,自动化流程禁用(见第 7 节第 4 条) |
| Utility_Methods | 通用工具函数 |
| View_Methods | 视图 / 视口 |
| Document_Methods | 文档级属性 |
| Application_Methods | 应用程序级 |
| Toolbar_Methods | 工具栏 |
| Rhino_Properties_Methods | COM 自动化对象属性(Visible / BringToTop 等,`get_rhino()` 已处理) |

### Step 2:列出模块的函数

```bash
python scripts/list_module_functions.py Curve_Methods
python scripts/list_module_functions.py Surface_and_Polysurface_Methods --limit 30
```

输出每个函数名 + 一行 purpose,根据描述判断该用哪个。

### Step 3:获取函数详情

```bash
python scripts/get_function_detail.py Curve_Methods AddCircle
```

返回 syntax、purpose、parameters、returns、example、see_also。**写代码前必须确认 syntax 和 parameters**。

只知道大概名字时全文搜索:

```bash
python scripts/get_function_detail.py --search Circle
python scripts/get_function_detail.py --search distance
```

## 3. 辅助函数

**核心原则:直接传 Python 嵌套 list 给 RhinoScript COM 一定会失败。** win32com 不会自动做 marshalling,必须用辅助函数包装成正确的 VARIANT 类型。选哪个函数,看 VBScript 语法结构即可:

```python
from PKPMAgent.software_link_kit.rhino import get_rhino, to_nested_variant_r8, to_nested_variant_i4, to_flat_variant_r8, to_flat_variant_i4, rgb
```

| VBScript 语法 | 含义 | Python 转换函数 |
|---|---|---|
| `Array(x, y, z)` | 单个点/向量 | 直接传 `[x, y, z]`,不需要转换 |
| `Array(Array(x,y,z), ...)` 子元素浮点 | 点/向量数组 | **`to_nested_variant_r8()`** |
| `Array(Array(i0,i1,...), ...)` 子元素整数 | 索引数组 | **`to_nested_variant_i4()`** |
| `Array(n1, n2, n3, ...)` 纯数字平铺 | knots / weights | **`to_flat_variant_r8()`** |
| `Array(i1, i2, ...)` 整数平铺 | 颜色数组 | **`to_flat_variant_i4()`** |
| `RGB(r, g, b)` | 单个颜色值 | **`rgb(r, g, b)`** |
| 字符串数组 `Array(str1, str2, ...)` | 对象 ID 列表等 | Python list 直接传,不需要转换 |

### 四个 Array 转换函数均同时支持列表形式与变参形式两种入参

四个 Array 转换函数：`to_nested_variant_r8`, `to_nested_variant_i4`,  `to_flat_variant_r8`,  `to_flat_variant_i4` 
```python
# 以 to_nested_variant_r8 为例
to_nested_variant_r8([(0,0,0), (10,0,0), (10,10,0)])  # 传一个列表
to_nested_variant_r8((0,0,0), (10,0,0), (10,10,0))    # 多参数变参
```

### 常见错误

- ❌ `rs.AddBox([[0,0,0],[10,0,0],...])` —— 嵌套 list,win32com 不会转换
- ❌ `rs.AddMesh(to_flat_variant_r8(verts), ...)` —— 用 flat 传点数组,部分函数会静默返回 `None`
- ❌ `rs.AddLayer("L1", [255,0,0])` —— 颜色不是数组,是单个 Long 整数

## 4. ⚠️ VB 示例转 Python 规范

**背景说明：** `get_function_detail.py` 检索到的 API syntax / example 都是 VBScript 形式。编写 Python 代码时，必须严格遵循以下转换规则——这些规则基于 win32com marshalling 的实际行为，违反任何一条都会导致 COM 错误或静默得到错误结果。

### 4.1 调用语法

| VBScript | Python COM |
|---|---|
| `Rhino.Foo arg1, arg2` | `script.Foo(arg1, arg2)` |
| `Rhino.X`（无参属性） | `script.X()`（同名方法,必须带括号） |

### 4.2 参数类型转换（VARIANT 包装）

**判断规则:看 VBScript 语法结构确定使用哪个转换函数**

| VBScript 语法 | Python 转换 | 示例函数 |
|---|---|---|
| `Array(x, y, z)` | `[x, y, z]` | AddCircle 圆心、MoveObject 起点/终点 |
| `Array(Array(x,y,z), ...)` | `to_nested_variant_r8(...)` | AddBox 角点、AddPolyline 点、AddMesh 顶点、平面参数 |
| `Array(Array(i0,i1,...), ...)` | `to_nested_variant_i4(...)` | AddMesh 面索引 |
| `Array(n1, n2, ...)` 纯数字 | `to_flat_variant_r8(...)` | AddNurbsCurve 的 knots / weights |

**平面参数（`arrPlane`）** 在 VB 中也是 `Array(Array(...), ...)` 结构（原点 + X/Y/Z 轴方向）,同样用 `to_nested_variant_r8`:
```python
import math
rad = math.radians(30)
plane = to_nested_variant_r8(
    (0, 0, 5000),                          # 原点
    (math.cos(rad), math.sin(rad), 0),     # X 轴
    (-math.sin(rad), math.cos(rad), 0),    # Y 轴
    (0, 0, 1),                             # Z 轴
)
rs.AddEllipse(plane, 12000, 8000)

# WorldXYPlane() 返回 tuple of tuples,不能直接传,重新包装:
base = rs.WorldXYPlane()  # ((0,0,0),(1,0,0),(0,1,0),(0,0,1))
rs.AddEllipse(to_nested_variant_r8(*base), 12000, 8000)
```

**AddMesh 完整示例**:
```python
verts = [(0,0,0), (10,0,0), (10,10,0), (0,10,0)]
faces = [[0,1,2,2], [0,2,3,3]]  # 三角面: i2==i3

mesh_id = rs.AddMesh(
    to_nested_variant_r8(verts),   # arrVertices: 浮点数组
    to_nested_variant_i4(faces),   # arrFaceVertices: 整数数组
)
```

### 4.3 颜色参数

| VBScript | Python COM |
|---|---|
| `RGB(255, 0, 0)` | `rgb(255, 0, 0)` |

RhinoScript 颜色参数（`lngColor` 或任何名称含 Color 的参数）是 32-bit Long 整数，不是 `[r,g,b]` 列表。传 `[r,g,b]` 会被当成 SAFEARRAY 导致错误。

### 4.4 可选参数 / Null 处理

| VBScript | Python COM |
|---|---|
| 省略可选参数 / `Null` | 直接不传，或用 `pythoncom.Empty` 占位 |
| 字符串参数传 `Null`（表示"当前/默认"） | 传空字符串 `""` |

**严禁传 `None`**：Rhino COM 的可选 VARIANT 参数收到 `None`（→`VT_NULL`）会打乱后续参数解析，或报 "String required"。要么省略不传，要么用 `pythoncom.Empty` / 空字符串 `""` 占位。

### 4.5 角度单位

RhinoScript 所有角度参数都是 **度**（degrees）。VB 示例中如此，Python 中也直接传度数，**不要换算成弧度**（跟 Python math 库的习惯不同）。

### 4.6 返回值约定

| 情况 | 说明 |
|---|---|
| 数组返回 | Python `tuple`（**不是 list**）。`AllObjects()`、`ObjectsByType()`、`BoundingBox()`、点坐标等都是 tuple。要修改 / `append` 时先 `list(ret)` 一层 |
| 失败 | 返回 `None`（对应 VBScript 的 `Null`） |
| `Add*` 方法 | 返回 GUID 字符串，作为后续操作的 ID |
| 判断是否数组 | VB 的 `IsArray(arr)` → Python 的 `isinstance(ret, tuple)` |

**`Add*` 返回 `None` 不等于"没问题"——这是 RhinoScript 的失败信号。** 大量 API 在参数类型/结构错误时不抛 COM 异常，而是静默返回 `None`，这与 Python "报错即失败"的习惯完全不同。遇到 `None` 返回值时，按以下顺序排查：
1. **VARIANT 嵌套结构是否正确？** 最常见原因。对 AddMesh 类函数，应该用 `to_nested_variant_r8/i4()` 而非 `to_flat_variant_r8()`（见 §4.2-B）
2. **几何数据是否退化？** 共线点、零面积面、重复顶点等会导致创建失败
3. **可选参数是否误传了 `None`？** 应传 `pythoncom.Empty` 或省略（见 §4.4）

## 5.选择执行路径:COM 调用 vs RunPythonScript

|  | COM 调用(本 SKILL.md 默认) | `rhino.RunScript("_-RunPythonScript ...")` |
|---|---|---|
| 适用场景 | Python ↔ Rhino 双向传数据 | 纯建模、不需要外部 Python 库 |
| 速度 | 每次方法调用跨进程,密集建模偏慢 | Rhino 进程内运行,快得多 |
| Python 解释器 | 你 venv 里的 CPython | Rhino 内嵌的解释器 |
| 第三方库 | 全部可用(numpy / scipy 等) | R7 及以前是 IronPython 2.7,**不能用 C 扩展库** |

**`RunScript` 属于 `rhino`（IRhinoInterface）,不是 `script`（IRhinoScript）。** 调用 `script.RunScript(...)` 会报 `AttributeError`。

**RunPythonScript 路径的两个硬约束**:
1. **R7 及以前内嵌 IronPython 2.7**,只能用纯 Python 库,不能 import numpy / scipy / shapely 等 C 扩展
2. **脚本含中文必须首行声明编码** `# -*- coding: utf-8 -*-`(IronPython 不会自动检测 BOM)

最小示例:
```python
script_path = "C:/temp/build_model.py"
with open(script_path, "w", encoding="utf-8") as f:
    f.write('''# -*- coding: utf-8 -*-
import rhinoscriptsyntax as rs
rs.AddBox([(0,0,0),(10,0,0),(10,10,0),(0,10,0),(0,0,5),(10,0,5),(10,10,5),(0,10,5)])
''')
rhino.RunScript(f'_-RunPythonScript "{script_path}"')
```

## 6. 常用操作示例

已校验的高频操作最小示例(基础图元、长方体、曲线、曲面、图层、变换、选择查询、文档打开/保存、视图截图等)见 `references/common_examples.md`。写代码前先查阅;涉及**打开/保存文件、截图**时必须按该文档的无对话框写法执行,严禁任何弹出对话框让用户选路径的行为。

## 7. 使用注意事项

1. **能直接构造几何就不要链式变换**:比如外扩椭圆,直接 `AddEllipse(plane, R+offset, ...)` 比 `ScaleObject` / `OffsetCurve` 更精确、更不容易踩 marshalling 的坑。
2. **不确定签名先查 db**:`python scripts/get_function_detail.py <module> <function>`。原 VBScript 文档示例需按第 4 节规范翻译。
3. **严禁用 `script.Command()` 建模**:`Command()` 每次调用都要跨进程解析命令字符串,比直接调 API 慢几个数量级。只有导入导出等没有专属 API 的操作才用 `Command()`。
4. **严禁在执行过程中引入任何用户交互——不限于文件对话框**:agent 的脚本必须无人值守跑完。执行中发起交互(等点选、拉框、键入、按键确认)会让 COM 调用永久阻塞:python_executor 卡死,用户看到的只是 Rhino 突然在等一个不明所以的操作,双方互相等死。三类都要防:
   - **User_Interface_Methods 整个模块视为禁区**:该模块 51 个函数几乎全部是 "Pauses for user input" 型取值函数(GetPoint / GetBox / GetRectangle / GetString / GetLayer / GetDistance...)或模态对话框(MessageBox / ListBox / EditBox / HtmlBox / PopupMenu,以及 OpenFileName / SaveFileName / BrowseForFolder 文件对话框——后三者还**并不真正读写文件**)。仅 GetCursorPos / SetCursorPos / MessageBeep 这类不阻塞的例外可用。
   - **Selection_Methods 里 "Prompts the user" 型函数同样禁止**:GetObject / GetObjects / GetObjectEx / GetPointCoordinates 等——即使传了预选参数,当前没有预选对象时它们照样转入阻塞等待。遍历/筛选用 AllObjects / ObjectsByType / ObjectsByLayer 等非交互查询。
   - **Command 命令串不许挂起**:命令缺输入时 Rhino 会就地转入交互等待(例如交互式剖切的拉框),`_Pause` 更是显式等用户——凡进 `Command()` 的命令,所有输入(坐标、选项、路径)必须在命令串里一次性给全;能用专属 API 就不用命令(如剖切用 Geometry_Methods/AddClippingPlane 传平面与尺寸,不要跑交互式 ClippingPlane 命令)。

   **用户预选必须支持,但方式是"读"而不是"等"**:用户经常先在 Rhino 里选好对象再向 agent 发指令——用非阻塞的 `SelectedObjects()` 读取即可;若返回为空,结束本次执行并在回复中请用户先选好对象,严禁降级成 GetObject 原地等待。拿不准某函数是否交互:查 db,purpose 含 "Pauses for user input" / "Prompts the user" / "Displays a ... dialog" 字样的一律不用,所需参数在 Python 侧算好传入。
5. **`EnableRedraw(False)` 可用于解决批量建模的效率问题,但开与关必须在同一段脚本内成对出现**:关闭重绘能大幅减少批量创建对象时的界面开销,允许使用;代价是关闭期间 Rhino 界面处于冻结状态,一旦恢复语句没有执行到,用户面对的就是一个假死、无法操作的 Rhino。因此:
   - `EnableRedraw(False)` 与 `EnableRedraw(True)` 必须写在**同一次 python_executor 调用的同一段代码**里,且恢复必须放进 `finally`,保证异常、用户中断等任何路径都能解冻;
   - 严禁"这一段脚本关闭重绘、下一段脚本再恢复"的跨调用写法——两次调用之间一旦出错或被中断,界面就回不来了;
   - 如果怀疑上一段脚本异常退出导致界面已冻结,先单独执行 `script.EnableRedraw(True)` 解冻。
   ```python
   script.EnableRedraw(False)
   try:
       for pt in points:          # 批量创建
           script.AddPoint(pt)
   finally:
       script.EnableRedraw(True)  # 与上面的 False 成对,钉死在 finally 里
       script.Redraw()
   ```
6. **COM 错误诊断**:
   - **抛出 `pywintypes.com_error`**:把异常的 `args` 打印出来排查:
     ```python
     import pywintypes
     try:
         box_id = script.AddBox(to_flat_variant_r8(...))
     except pywintypes.com_error as e:
         print("COM error:", e.args)
         raise
     ```
   - **静默返回 `None`**:更隐蔽的失败模式——不抛异常,但对象创建失败。排查步骤见 §4.6。
7. **所有输出文件一律落到会话工作目录**:python_executor 已把当前会话的工作目录注入为变量 `WORKSPACE_DIR`(执行期间 cwd 也已切到该目录)。SaveAs / Export / 截图等落盘输出,除非用户明确指定了其他位置,一律 `os.path.join(WORKSPACE_DIR, "文件名")` 拼成**绝对路径**再传给 Rhino——Rhino 是独立进程,它的相对路径不会解析到工作目录。具体写法见 `references/common_examples.md`。