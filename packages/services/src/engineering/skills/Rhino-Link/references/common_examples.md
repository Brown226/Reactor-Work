# 常用操作示例(已校验)

高频操作的最小示例。其它 API 写代码前用 `get_function_detail.py` 查清楚。

所有示例默认已执行过下面的准备代码,`rs` 即 `get_rhino()` 返回的 script(IRhinoScript)接口:

```python
from PKPMAgent.software_link_kit.rhino import get_rhino, to_nested_variant_r8, to_nested_variant_i4, to_flat_variant_r8, to_flat_variant_i4, rgb

rhino, script, version = get_rhino()
rs = script
```

## 基础图元(单点参数,不需要转换)

```python
rs.AddPoint([0, 0, 0])
rs.AddLine([0, 0, 0], [100, 0, 0])
rs.AddCircle([0, 0, 0], 50)                  # 圆心 + 半径,默认 WorldXY 平面
rs.AddSphere([0, 0, 0], 50)
rs.AddCylinder([0, 0, 0], [0, 0, 100], 25)   # 底心、顶心、半径
rs.AddCone([0, 0, 0], [0, 0, 100], 25)       # 底心、顶点、底半径
```

## 长方体(8 个角点,逆时针,先底后顶)

```python
box_id = rs.AddBox(to_nested_variant_r8(
    (0, 0, 0), (10, 0, 0), (10, 10, 0), (0, 10, 0),    # 底面
    (0, 0, 5), (10, 0, 5), (10, 10, 5), (0, 10, 5),    # 顶面
))
```

## 折线 / 插值曲线 / NURBS(点数组用 to_nested_variant_r8)

```python
points = [(0, 0, 0), (50, 50, 0), (100, 0, 0), (150, 50, 0)]

rs.AddPolyline(to_nested_variant_r8(points))
rs.AddInterpCurve(to_nested_variant_r8(points))                  # 默认 degree=3
rs.AddInterpCurve(to_nested_variant_r8(points), 5)               # degree=5

# NURBS：控制点(点数组) → to_nested_variant_r8
#        节点(纯数字平铺) → to_flat_variant_r8
knots = [0, 0, 0, 0.5, 1, 1, 1]                   # len = len(points) + degree - 1
rs.AddNurbsCurve(to_nested_variant_r8(points), to_flat_variant_r8(knots), 3)
```

## 网格(AddMesh — 嵌套数组参数)

```python
verts = [(0,0,0), (10,0,0), (10,10,0), (0,10,0)]
faces = [[0,1,2,2], [0,2,3,3]]  # 三角面: 最后两个索引相同; 四边面: 4 个不同索引

mesh_id = rs.AddMesh(
    to_nested_variant_r8(verts),   # arrVertices: 浮点数组
    to_nested_variant_i4(faces),   # arrFaceVertices: 整数数组
)
```

## 平面构造与使用

平面在 VB 中是 `Array(Array(原点), Array(X轴), Array(Y轴), Array(Z轴))`，用 `to_nested_variant_r8`。
`WorldXYPlane()` 等函数返回的 tuple of tuples 不能直接回传，必须重新包装。

```python
import math

# 在 Z=5000 处创建一个绕 Z 轴旋转 30° 的平面
rad = math.radians(30)
plane = to_nested_variant_r8(
    (0.0, 0.0, 5000.0),                          # 原点
    (math.cos(rad), math.sin(rad), 0.0),          # X 轴
    (-math.sin(rad), math.cos(rad), 0.0),         # Y 轴
    (0.0, 0.0, 1.0),                              # Z 轴
)
rs.AddEllipse(plane, 12000, 8000)

# ❌ 错误：WorldXYPlane() 返回值直接传
# base = rs.WorldXYPlane()
# rs.AddEllipse(base, 12000, 8000)  → Type mismatch

# ✅ 正确：重新包装
base = rs.WorldXYPlane()  # ((0,0,0),(1,0,0),(0,1,0),(0,0,1))
rs.AddEllipse(to_nested_variant_r8(*base), 12000, 8000)
```

## 曲面操作

```python
# 放样:多条曲线 ID 列表(纯字符串,直接 list 即可)
rs.AddLoftSrf([curve1_id, curve2_id, curve3_id])

# 沿路径挤出:被挤出曲线 ID + 路径曲线 ID,两个都是字符串
rs.ExtrudeCurve(profile_curve_id, path_curve_id)

# 旋转成面:profile 曲线 ID + 旋转轴(两个端点,点数组) + 起止角(度)
rs.AddRevSrf(profile_id, to_nested_variant_r8((0,0,0), (0,0,1)), 0, 360)

# 布尔运算:两组对象 ID 列表(字符串列表,直接 list 即可)
rs.BooleanDifference([target_id], [tool_id])      # 第一个参数是被减集
rs.BooleanUnion([id1, id2, id3])
rs.BooleanIntersection([a_id], [b_id])
```

## 图层

```python
rs.AddLayer("Walls", rgb(255, 0, 0))
rs.CurrentLayer("Walls")
rs.ObjectLayer(obj_id, "Walls")
rs.LayerVisible("Walls", False)
rs.LayerLocked("Walls", True)
```

## 对象变换

```python
rs.MoveObject(obj_id, [0, 0, 0], [100, 100, 0])    # 起点 → 终点
rs.CopyObject(obj_id, [0, 0, 0], [100, 100, 0])
rs.RotateObject(obj_id, [0, 0, 0], 45)             # 中心 + 度
rs.ScaleObject(obj_id, [0, 0, 0], [2, 2, 2])       # 缩放因子是 list,不是 3 个独立参数
rs.MirrorObject(obj_id, [0, 0, 0], [1, 0, 0])      # 镜像线两端
rs.DeleteObject(obj_id)
```

## 对象选择与查询

```python
all_ids = rs.AllObjects()                          # tuple 或 None
all_ids = list(all_ids) if all_ids else []
curves = rs.ObjectsByType(4)                       # 4=曲线 8=曲面 16=网格 32=多曲面
rs.SelectObject(obj_id)                            # 程序化选中(高亮),非交互,可用

bbox = rs.BoundingBox(obj_id)                      # tuple of 8 角点
otype = rs.ObjectType(obj_id)
layer = rs.ObjectLayer(obj_id)
```

### 用户预选:用"读"不用"等"

用户经常先在 Rhino 里选中若干对象再向 agent 发指令("把选中的这些…")。正确接法是非阻塞地**读取**已有选择;当前没有选择时结束执行、在回复中请用户先选好,**严禁**改用 `GetObject` / `GetObjects` 原地等待——它们即使带预选参数,没有预选时也会转入阻塞等待用户点选,python_executor 就卡死了。

```python
selected = rs.SelectedObjects()                    # 非阻塞读取用户已选对象,tuple 或 None
ids = list(selected) if selected else []
if not ids:
    print("用户当前未选中任何对象")   # 就此结束本轮,在回复中请用户先在 Rhino 中选好对象
```

## 文档:打开 / 保存 / 新建(⚠️ 只能走 Command,绝不允许弹对话框)

RhinoScript **没有** `OpenFile` / `SaveFile` / `NewDocument` 这类 API,文档级操作只能用 `rs.Command()` 执行脚本化命令。三条铁律:

1. 命令名用 `_-` 前缀:`_` 保证英文命令名,`-` 抑制对话框。**漏掉 `-` 会弹出文件对话框**,执行被卡死,用户还得手动处理。
2. 保存/导入/导出**必须在命令串里给出完整绝对路径**,路径包在双引号里(防路径含空格)。**输出文件默认放进会话工作目录**:python_executor 已注入变量 `WORKSPACE_DIR`,用 `os.path.join(WORKSPACE_DIR, 文件名)` 拼路径——Rhino 是独立进程,相对路径不会落到工作目录。绝不允许弹对话框让用户选路径。
3. `SaveFileName` / `OpenFileName` / `BrowseForFolder` 是 **User_Interface_Methods 里的对话框函数**:只弹窗让用户挑一个文件名,**并不真正保存/打开任何文件**。执行中一切交互调用均被禁止(完整规则见 SKILL.md 第 7 节第 4 条),文件对话框只是最常见的踩坑点。

```python
import os

save_dir = globals().get("WORKSPACE_DIR") or os.getcwd()  # 会话工作目录(python_executor 已注入)

# 保存:_-SaveAs + 完整绝对路径
path = os.path.join(save_dir, "model_v1.3dm")
rs.Command(f'_-SaveAs "{path}" _Enter')
print(rs.LastCommandResult())              # 0=成功 1=用户取消 3=失败 4=未知命令
print(rs.DocumentPath(), rs.DocumentName())  # 验证当前文档的落盘位置

# 打开:用户提供的现有文件,用其原始绝对路径;先清"已修改"标记,否则会弹 "是否保存当前更改?" 对话框
rs.DocumentModified(False)
rs.Command('_-Open "C:/models/test.3dm" _Enter')

# 新建:同样先清修改标记;_None 表示不使用模板
rs.DocumentModified(False)
rs.Command('_-New _None')

# 导入 / 导出同理:显式路径 + _Enter 确认
stl_path = os.path.join(save_dir, "output.stl")
rs.Command(f'_-Export "{stl_path}" _Enter _Enter')
rs.Command('_-Import "C:/data/input.igs" _Enter')
```

- `Command()` 一次只能执行**一条**命令,不要把多条命令拼进同一个字符串。
- **命令串里严禁 `_Pause`**;命令一旦缺输入,Rhino 会就地转入交互等待(等点选/拉框),python_executor 随之永久卡死——所有输入必须一次性给全。
- 成败判断:`Command()` 返回 True/False,更细的原因看 `rs.LastCommandResult()`(0 才是成功)。
- 用户明确指定了工作目录以外的保存路径时,先 `os.makedirs(目录, exist_ok=True)` 确保目录存在(工作目录本身始终存在,不用建)。

## 视图截图(CreatePreviewImage,无对话框)

截图用 `Document_Methods/CreatePreviewImage`,把当前模型渲染成图片文件。格式由扩展名决定(png / jpg / bmp / tif / tga / pcx)。**strFile 必须给完整绝对路径,默认拼在会话工作目录 `WORKSPACE_DIR` 下**——传裸文件名会落到不可预知的目录。RhinoScript 没有 ViewCaptureToFile 这类 API,不要发明。

```python
import os

save_dir = globals().get("WORKSPACE_DIR") or os.getcwd()  # 会话工作目录(python_executor 已注入)
shot = os.path.join(save_dir, "rhino_view.png")

rs.ZoomExtents()                                 # 先把模型收进画面再截
ok = rs.CreatePreviewImage(shot)                 # 当前激活视图,默认尺寸
ok = rs.CreatePreviewImage(shot, "Perspective",  # 指定视图 + 分辨率
                           to_flat_variant_i4(900, 1600))
ok = rs.CreatePreviewImage(shot, "Top",
                           to_flat_variant_i4(1600, 900), 2, True)  # 2=画工作平面, True=线框
print("截图成功:" + shot if ok else "截图失败")
```

- `arrSize` 是两个整数的平铺数组 → 用 `to_flat_variant_i4(width, height)` 包装。可以自行确定使用横板还是竖版。
- `intFlags` 可按位组合:1=保留高亮 2=绘制工作平面 4=ghosted 着色。
- 返回 False 常见原因:视图名不存在、目标目录不存在。

## 视图与单位

```python
rs.Redraw()
rs.ZoomExtents()
rs.ZoomSelected()

rs.UnitSystem(2) # 2=mm 4=m 5=in 8=cm
rs.AbsoluteTolerance(0.01)
rs.AngleTolerance(1.0)
```
