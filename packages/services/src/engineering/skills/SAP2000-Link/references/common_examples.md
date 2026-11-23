# SAP2000 常用示例

> 单位制 N_mm_C。COM 返回元组的**最后一个元素是 ret，0 = 成功**；ByRef 出参用 `0 / ' ' / []` 占位，个数必须与 VB 签名一致。
> 坐标系与内力符号约定见 SKILL.md，本文不重复。

## 1. 最小完整脚本：连接 → 建模 → 分析 → 取结果

可直接运行。后续各节只补充这里没有的内容。

```python
import os
import comtypes.client

comtypes.CoInitialize()
helper = comtypes.client.CreateObject('SAP2000v1.Helper')
helper = helper.QueryInterface(comtypes.gen.SAP2000v1.cHelper)

# —— 连接：优先已运行实例；无实例时 GetObject 返回 None 而非抛异常 ——
sap = helper.GetObject("CSI.SAP2000.API.SapObject")
if sap is None:
    sap = helper.CreateObjectProgID("CSI.SAP2000.API.SapObject")
    sap.ApplicationStart()
SapModel = sap.SapModel

# —— 新建模型：SetPresentUnits 必须放在 NewBlank 之后，否则会被重置 ——
SapModel.InitializeNewModel()
SapModel.File.NewBlank()
SapModel.SetPresentUnits(9)                                       # 9 = N_mm_C
assert SapModel.GetPresentUnits() == 9

# —— 材料与截面 ——
SapModel.PropMaterial.SetMaterial('CONC', 2)                      # 2 = Concrete
SapModel.PropMaterial.SetMPIsotropic('CONC', 30000, 0.2, 0.00001) # E[N/mm²], 泊松比, 线膨胀[1/℃]
# SetRectangle(名, 材料, t3, t2): t3 = 沿局部 2 轴尺寸（水平梁的梁高）, t2 = 沿局部 3 轴（梁宽）
# 故 (..., 500, 300) 的强轴惯性矩 I33 = 300*500³/12 = 3.125e9
SapModel.PropFrame.SetRectangle('RC400', 'CONC', 400, 400)
SapModel.PropFrame.SetRectangle('RC500x300', 'CONC', 500, 300)

# —— 荷载模式：第 3 参 = 自重系数, 第 4 参 True = 同时创建同名线性静力工况 ——
SapModel.LoadPatterns.Add('TEST', 8, 0, True)                     # 8 = Other

# —— 悬臂柱 H=3000: 柱底固端, 柱顶 +X 10kN、-Z 100kN ——
# AddByCoord(xI,yI,zI, xJ,yJ,zJ, 名占位, 截面, 标签, 坐标系); 前一坐标点为 I 端
[col, ret] = SapModel.FrameObj.AddByCoord(0, 0, 0, 0, 0, 3000, ' ', 'RC400', 'COLP', 'Global')
[cI, cJ, ret] = SapModel.FrameObj.GetPoints(col, ' ', ' ')
SapModel.PointObj.SetRestraint(cI, [True] * 6)                    # [UX,UY,UZ,RX,RY,RZ]
SapModel.PointObj.SetLoadForce(cJ, 'TEST', [10000, 0, -100000, 0, 0, 0])   # 全局坐标, N 与 N·mm

# —— X 向简支梁 L=6000: 满跨向下 w=10 N/mm（= 10 kN/m）——
[beam, ret] = SapModel.FrameObj.AddByCoord(0, 5000, 3000, 6000, 5000, 3000, ' ', 'RC500x300', 'BEAMX', 'Global')
[bI, bJ, ret] = SapModel.FrameObj.GetPoints(beam, ' ', ' ')
SapModel.PointObj.SetRestraint(bI, [True, True, True, True, False, False])  # I 端加 RX, 免去绕梁轴的刚体转动
SapModel.PointObj.SetRestraint(bJ, [True, True, True, False, False, False])
# SetLoadDistributed(名, 工况, MyType, Dir, Dist1, Dist2, Val1, Val2, CSys, RelDist, Replace, ItemType)
# MyType: 1=力/长度 2=弯矩/长度
# Dir: 1~3=局部轴 4~6=整体 XYZ 7~9=投影 XYZ 10=重力方向(正值向下) 11=投影重力
# RelDist 默认 True, 故 Dist1=0、Dist2=1 表示满跨
SapModel.FrameObj.SetLoadDistributed(beam, 'TEST', 1, 10, 0, 1, 10, 10)

# —— 分析：必须先存盘, 否则取不到结果; RunAnalysis 后模型被锁定 ——
SapModel.View.RefreshView(0, False)
SapModel.File.Save(os.path.abspath('verify.sdb'))
SapModel.Analyze.RunAnalysis()
# 要继续改模型: SapModel.SetModelIsLocked(False)

# —— 结果前置：不选工况则所有提取函数返回 0 行 ——
SapModel.Results.Setup.DeselectAllCasesAndCombosForOutput()
SapModel.Results.Setup.SetCaseSelectedForOutput('TEST')           # 组合用 SetComboSelectedForOutput

# 占位符个数 = VB 签名的 ByRef 参数个数, 数错直接报 "call takes exactly N arguments"
# 节点位移（全局坐标, U1/U2/U3 → X/Y/Z）: Obj,Elm,Case,StepType,StepNum,U1~U3,R1~R3 = 11 个
[nr, Obj, Elm, Case, StepType, StepNum, U1, U2, U3, R1, R2, R3, ret] = \
    SapModel.Results.JointDispl(cJ, 0, 0, *[[] for _ in range(11)])

# 杆件内力（局部坐标）: Obj,ObjSta,Elm,ElmSta,Case,StepType,StepNum,P,V2,V3,T,M2,M3 = 13 个
[nr, Obj, ObjSta, Elm, ElmSta, Case, StepType, StepNum, P, V2, V3, T, M2, M3, ret] = \
    SapModel.Results.FrameForce(col, 0, 0, *[[] for _ in range(13)])
for sta, p_, v2_, m3_ in zip(ObjSta, P, V2, M3):
    print(f'sta={sta:7.0f}  P={p_:10.0f}  V2={v2_:9.0f}  M3={m3_:12.0f}')

# 节点力（全局坐标, 节点作用于杆端的力, 无需翻转符号）: 12 个
[nr, Obj, Elm, PointElm, Case, StepType, StepNum, F1, F2, F3, M1, M2, M3, ret] = \
    SapModel.Results.FrameJointForce(col, 0, 0, *[[] for _ in range(12)])

# 支座反力（全局坐标）: 11 个
[nr, Obj, Elm, Case, StepType, StepNum, F1, F2, F3, M1, M2, M3, ret] = \
    SapModel.Results.JointReact(cI, 0, 0, *[[] for _ in range(11)])
# 取全部支座反力: Name='ALL' + ItemTypeElm=2（Group 方式）
```

## 2. 截面

标准截面的定义见 §1。下面展开需要额外步骤的类型。

**eFramePropType（`PropFrame.GetTypeOAPI` 返回值）**

| 码 | 类型 | 码 | 类型 | 码 | 类型 |
|----|------|----|------|----|------|
| 1 | I 工字钢 | 8 | Rectangular 矩形 | 15 | Joist |
| 2 | Channel 槽钢 | 9 | Circle 实心圆 | 16 | Bridge |
| 3 | Tee | 10 | General 通用 | 17~22 | 冷弯 C/2C/Z/L/2L/HAT |
| 4 | Angle 角钢 | 11 | DbChannel | 23 | BuiltupI+盖板 |
| 5 | DblAngle | 12 | Auto | 24/25 | PCC 工字/U 形梁 |
| 6 | Box 箱形 | **13** | **SD (Section Designer)** | 26/27 | 组合工字/U 梁(混合) |
| 7 | Pipe 钢管 | 14 | Variable 变截面 | 41~46 | PCC SuperT / 冷弯箱·圆·T / 梯形 |

### SD 组合截面

"钢管 + 内填混凝土"这类截面在 SAP2000 里是 Section Designer 组合截面（类型码 13），**不能**当标准 Pipe 处理，`PropFrame.GetPipe` 对它无效。读既有模型时按下面三步解析：

```python
SD = 'C1200*40'

# 第一步: 判类型
[prop_type, ret] = SapModel.PropFrame.GetTypeOAPI(SD, 0)
assert prop_type == 13, f'不是 SD 截面, 类型码={prop_type}'

# 第二步: 枚举 SD 内部形状
[MatProp, NumberItems, ShapeName, MyType, DesignType, Color, Notes, GUID, ret] = \
    SapModel.PropFrame.GetSDSection(SD, ' ', 0, [], [], 0, 0, ' ', ' ')
# → MatProp='STEEL', NumberItems=2, ShapeName=['TUBE','CORE'], MyType=[7, 102]

# 第三步: 按 MyType 分派到对应的 SDShape.GetXxx 读几何
for nm, tp in zip(ShapeName, MyType):
    if tp == 7:                                       # Pipe
        [mat, propName, color, xc, yc, dia, thk, ret] = \
            SapModel.PropFrame.SDShape.GetPipe(SD, nm, ' ', ' ', 0, 0, 0, 0, 0)
        # → mat='STEEL', dia=1200, thk=40
    elif tp == 102:                                   # SolidCircle
        [mat, ss, color, xc, yc, dia, reinf, nbars, rot, cover, barsize, matrebar, ret] = \
            SapModel.PropFrame.SDShape.GetSolidCircle(SD, nm, ' ', ' ', 0, 0, 0, 0, False, 0, 0, 0, ' ', ' ')
        # → mat='CONC', dia=1120
```

新建 SD 截面：先 `SetSDSection` 指定基材，再逐个加形状（形状在截面坐标系内用 XCenter/YCenter 定位）。赋给杆件后与普通截面无异，可直接参与分析。

```python
SD = 'SD_C1200x40'
SapModel.PropFrame.SetSDSection(SD, 'STEEL')
# ShapeName 传 ' ' 时程序自动命名并在返回元组中带回（如 'TUBE' / 'CORE'）
[shape1, ret] = SapModel.PropFrame.SDShape.SetPipe(SD, ' ', 'STEEL', '', 0, 0, -1, 1200, 40)
[shape2, ret] = SapModel.PropFrame.SDShape.SetSolidCircle(SD, ' ', 'CONC', 'Default', 0, 0, 1120, -1, False)
```

其他形状同理：`SetISection / SetRectangle / SetCircle / SetBox / SetAngle / SetPlate / SetPolygon`。

检索这批函数时注意：COM 属性名是 `PropFrame.SDShape`（无下划线），但库里的模块路径是 **`Definitions/Properties/Frame/SD_Shape`**（有下划线），按 COM 名去查会一无所获。该模块下有 43 个函数，`Get*` 21 个。

**SD 形状类型（`GetSDSection` 的 MyType 数组）**

| 码 | 形状 | 码 | 形状 | 码 | 形状 |
|----|------|----|------|----|------|
| 1 | I 工字 | 8 | Plate 板 | 103 | Solid Segment |
| 2 | Channel | 101 | Solid Rectangle | 104 | Solid Sector |
| 3 | Tee | **102** | **Solid Circle** | 201 | Polygon |
| 4 | Angle | 301 | 单根钢筋 | 401/402 | 参考线/参考圆 |
| 5 | Double Angle | 302 | 线配筋 | 501~504 | Caltrans 方/圆/六/八边形 |
| 6 | Box | 303 | 矩形配筋 | | |
| **7** | **Pipe** | 304 | 圆形配筋 | | |

## 3. 荷载模式与工况

荷载模式是"荷载的容器"，分析工况（LoadCase）决定如何求解；`LoadPatterns.Add(..., True)` 会顺带创建同名线性静力工况。
常用模式类型：`1=Dead 2=Live 3=Quake 4=Wind 8=Other`。

```python
# 查工况类型: 用 GetTypeOAPI_1，不要用只返回 [CaseType, ret] 的旧版 GetTypeOAPI
[CaseType, SubType, DesignType, DesignTypeOption, Auto, ret] = \
    SapModel.LoadCases.GetTypeOAPI_1('TEST', 0, 0, 0, 0, 0)
# → CaseType=1(LinearStatic), DesignType=8(Other)
```

CaseType（eLoadCaseType）：`1=LinearStatic 2=NonlinearStatic 3=Modal 4=ResponseSpectrum 5/6=模态时程 7/8=直接积分时程 9=MovingLoad 10=Buckling`。

## 4. 坑

| 坑 | 现象 | 对策 |
|-----|------|------|
| 出参占位符个数错 | `call takes exactly N arguments` / 解包失败 | 个数必须等于 VB 签名的 ByRef 参数个数；拿不准先 `print()` 原始返回元组再解包 |
| 同名旧版函数 | `LoadCases.GetTypeOAPI` 只返回 2 个值，信息不全 | 检索结果带 "Newer Function Available" 标记时改用 `_1` 版本 |
| `SetLoadForce` 默认不覆盖 | 签名里 `Replace` 默认 **False**，同一节点同一工况重复调用会累加 | 重跑脚本前重建模型，或显式传 `Replace=True` |
| 悬浮杆件 | 无约束无荷载的测试杆留在模型里，可能奇异或污染结果 | 测完删除，或另建文件测试 |
