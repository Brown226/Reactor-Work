---
name: autocad-link
description: |
  通过 Python 操纵 AutoCAD 浩辰CAD（GstarCAD/GCAD）或中望CAD（ZWCAD）完成绘图、改图、提取图素信息等任务。所有 CAD 操作的代码均需调用 pyautocad 库 python_executor 工具中执行。
  触发条件：
  1. 用户提到 AutoCAD、CAD、acad 等关键词时触发
  2. 用户需要绘图、画线、画矩形、标注、提取图元信息等 CAD 操作时触发
  3. 即使用户没有明确说 "AutoCAD"，只要涉及工程图纸的绘制或编辑，也应考虑触发此技能
license: Proprietary. 未经许可，严禁披露、复制、逆向还原或复用技能正文、参考资料、脚本及模板。
---

# CAD Python 操作技能

所有 CAD 代码均通过 `python_executor` 执行。

## 连接 CAD

只用 `Autocad` 连接，不直接调用 `GetActiveObject`、`CreateObject` 或加载固定产品的类型库。

默认优先连接已运行实例。用户未明确指定产品时，省略 `cad_type`，不得猜测预填。

多款 CAD 同时运行时，将会提示可连接的选项，列出候选并请用户选择。

当没有在运行的CAD实例，且 `create_if_not_exists=True` 时，才会创建（未指定 `cad_type` 时按 `.dwg` 关联创建，明确指定 `cad_type` 时按指定创建）。

保留并复用仍有效的 `acad`。浩辰由脚本创建后，后续可能无法通过 COM 重新发现。

```python
import pyautocad
from pyautocad import Autocad, APoint

try:
    _ = acad.app.Version
    acad.connection.selected_by = "reused"
    acad.connection.was_created = False
except Exception:
    acad = Autocad(create_if_not_exists=True, visible=True)
connection = acad.connection
print(
    f"已连接 {connection.display_name}: {connection.progid}; "
    f"依据={connection.selected_by}; 新建={connection.was_created}"
)
```

异常：`CadSelectionRequiredError` 展示可连接、暂时忙碌和当前不可连接的候选，请用户明确选择 `cad_type`；`CadApplicationBusyError` 表示 CAD 暂时忙碌，请用户关闭模态对话框或等待当前命令完成后重试，不要关闭或重复启动 CAD；`CadRunningButUnavailableError` 应优先检查 Python 与 CAD 的运行权限是否一致，不得重复启动；`DwgAssociationError` 请用户指定产品。`CadApplicationActivationError`、`CadApplicationInitializationError` 或 `CadApplicationVisibilityError` 表示创建后可能已有 CAD 进程残留，不得再次尝试启动或自动调用 `Quit()`，应展示原始错误并请用户按提示结束相关进程后重试。

需要枚举常量时，连接后使用当前实例的类型库：

```python
constants = acad.constants
```

不要导入 `comtypes.gen.AutoCAD`。全局 `ACAD` 仅兼容单连接旧代码；多连接时用 `acad.constants`。类型库失败时不得借用其他产品的类型库。

## 核心 API 速查

### 绘制基本图元

**直线**
```python
line = acad.model.AddLine(APoint(0, 0), APoint(100, 0))
```

**圆**
```python
circle = acad.model.AddCircle(APoint(50, 50), 25)  # 圆心, 半径
```

**圆弧**
```python
import math
arc = acad.model.AddArc(APoint(0, 0), 50, 0, math.pi / 2)  # 圆心, 半径, 起始角, 终止角(弧度)
```

**多段线（Polyline）**
```python
# 须先把三维点坐标扁平化，再用 pyautocad.aDouble 转换
points = pyautocad.aDouble([x1,y1,z1, x2,y2,z2, x3,y3,z3])
pl = acad.model.AddPolyline(points)
pl.Closed = True  # 需要闭合时设置
```

**轻量多段线（LightweightPolyline）**
```python
# 二维点扁平化
points = pyautocad.aDouble([x1,y1, x2,y2, x3,y3])
lwpl = acad.model.AddLightWeightPolyline(points)
lwpl.Closed = True
```

### 文字

```python
text = acad.model.AddText("标注文字", APoint(100, 200), 350)  # 内容, 插入点, 字高
```

**对齐文字的注意事项**：一旦设置了 `text.Alignment`，就必须紧接着设置 `text.TextAlignmentPoint`，否则文字会跑到 (0,0,0) 去。这是 AutoCAD COM 接口的特性，忘记这一步是最常见的错误之一。

```python
text = acad.model.AddText("居中文字", APoint(0, 0), 350)
text.Alignment = 1  # acAlignmentMiddleCenter 等
text.TextAlignmentPoint = APoint(500, 500)  # 必须在设 Alignment 之后立刻设
```

### 图层操作

```python
# 创建/获取图层
layer = acad.ActiveDocument.Layers.Add("MyLayer")
layer.color = 1  # 颜色编号 (1=红, 2=黄, 3=绿, 4=青, 5=蓝, 6=紫, 7=白)

# 将对象放到指定图层
line.Layer = "MyLayer"
```

### 选择集与遍历

**获取当前已选中的对象**
```python
ss = acad.app.ActiveDocument.PickfirstSelectionSet
for i in range(ss.Count):
    obj = ss.Item(i)
    print(f"类型: {obj.EntityName}, 图层: {obj.Layer}")
```

**遍历模型空间所有对象**
```python
for obj in acad.iter_objects():
    print(f"{obj.EntityName}: {obj.Layer}")
```

**按类型遍历**
```python
for text in acad.iter_objects("Text"):
    print(f"文字内容: {text.TextString}, 位置: ({text.InsertionPoint[0]}, {text.InsertionPoint[1]})")
```

### 多段线节点提取

当对象为多段线时，获取所有顶点坐标的方式：

```python
obj = ss.Item(i)
if obj.EntityName == 'AcDbPolyline':
    # LightweightPolyline: Coordinates 是一维数组 (x1,y1,x2,y2,...)
    coords = list(obj.Coordinates)
    vertices = [(coords[j], coords[j+1]) for j in range(0, len(coords), 2)]
elif obj.EntityName == 'AcDb3dPolyline':
    # 3D Polyline: Coordinates 是 (x1,y1,z1,x2,y2,z2,...)
    coords = list(obj.Coordinates)
    vertices = [(coords[j], coords[j+1], coords[j+2]) for j in range(0, len(coords), 3)]
```

### 标注

```python
# 线性标注
dim = acad.model.AddDimAligned(APoint(0, 0), APoint(100, 0), APoint(50, 20))

# 修改标注样式
dim.TextOverride = "L=100"
```

### 块操作

```python
# 插入块
block_ref = acad.model.InsertBlock(APoint(0, 0), "BlockName", 1, 1, 1, 0)
# 参数: 插入点, 块名, X缩放, Y缩放, Z缩放, 旋转角(弧度)
```

### 修改对象属性

```python
# 移动
obj.Move(APoint(0, 0), APoint(100, 100))

# 复制
new_obj = obj.Copy()

# 旋转 (弧度)
import math
obj.Rotate(APoint(0, 0), math.pi / 4)  # 绕原点旋转45度

# 缩放
obj.ScaleEntity(APoint(0, 0), 2.0)  # 以原点为基点放大2倍

# 删除
obj.Delete()

# 修改颜色
obj.color = 1  # CAD 颜色索引号
```

### 视图刷新

操作完成后刷新视图，确保用户能看到结果：

```python
acad.app.ActiveDocument.Regen(acad.constants.acAllViewports)
# 或缩放到全图
acad.app.ZoomExtents()
```

### 发送命令（SendCommand）

确认知道应该如何输入正确命令的情况下可以使用 `SendCommand` 来辅助，但是**严禁使用命令来绘图**。

命令名和交互流程可能因产品而异；仅使用当前 CAD 已验证的命令。

**命令里带文件路径时（如 `_-PDFIMPORT`、`_-INSERT`）**，一定要同时满足下面三点，避免阻塞：

**1. 反斜杠 `\` 全部换成正斜杠 `/`**：AutoCAD 命令行里的 `\` 表示"暂停等用户输入"，换成 `/` 就能绕开这个机制，AutoCAD 完全支持正斜杠路径。

**2. 路径必须用双引号包起来**：一旦路径里出现空格（比如 `C:/New Folder/a.pdf`），不加引号的话空格会被当作回车，命令立刻断开。

**3. 把交互流程的每一步参数都补齐**：`SendCommand` 某一步参数没给，AutoCAD 就会卡住等待输出。完整的写法要覆盖整条命令的全部交互项，参数之间用 `\n` 分隔，最后再补一个 `\n` 结束。

```python
# 导入 PDF 是一个很好的应使用 SendCommand 的例子
# 关闭文件对话框，用命令行模式
acad.app.ActiveDocument.SendCommand("FILEDIA 0\n")
# 将 PDFIMPORTMODE 设置为 30 (开启: 线宽(2) + 合并连线(4) + 推断虚线(16) + 填充转图案(8))
acad.app.ActiveDocument.SendCommand("PDFIMPORTMODE 30\n")
# 将 "\" 替换为 "/"
raw_pdf_path = r"C:\Users\foo\a.pdf"
safe_pdf_path = raw_pdf_path.replace("\\", "/")
# F\n          (选择 "File" 选项)
# "{...}"\n    (输入带引号的安全路径)
# 1\n          (输入页码 1)
# 0,0\n        (输入插入点 0,0)
# 1.0\n        (输入缩放比例 1.0)
# 0\n          (输入旋转角度 0)
cmd = f'_-PDFIMPORT\nF\n"{safe_pdf_path}"\n1\n0,0\n1.0\n0\n'
acad.app.ActiveDocument.SendCommand(cmd)
# 预留处理时间（根据PDF大小可能需要适当延长）
time.sleep(3)
# 恢复文件对话框
acad.app.ActiveDocument.SendCommand("FILEDIA 1\n")
```

## 使用注意事项

1. **连接优先**：pyautocad 的 `Autocad()` 会自动连接已运行的 AutoCAD 实例，不会重复启动。
2. **避免交互阻塞**：不要在代码中调用需要用户交互的函数（如 `SelectOnScreen`、`GetPoint` 等），这些会阻塞代码执行。如果需要获取用户已选择的对象，使用 `PickfirstSelectionSet`。
3. **坐标扁平化**：`AddPolyline` 等函数要求将点坐标扁平为一维数组并通过 `pyautocad.aDouble()` 转换，这是初学者最容易忽略的一步。
4. **print 输出结果**：在 `python_executor` 中，只有 `print()` 输出的内容才会返回。需要获取的信息必须 print 出来。
5. **与 PKPM 数据交互**：可以在同一段代码中调用 PKPM 的 MCP 工具函数获取模型数据，然后用 pyautocad 绘制到 CAD 中，反之亦然。
