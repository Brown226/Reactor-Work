---
name: sap2000-link
description: |
  操作 SAP2000 进行结构分析、建模、结果提取。本技能有一套高效的 sap2000 API 渐进式检索机制，可以查到完成任务所必需的 sap2000 API 函数。所有任务都应通过 Python com 接口编写脚本操控 SAP2000 完成。
  触发条件：
  1. 用户提到 SAP2000、SAP 等关键词时触发此技能
  2. 用户需要做结构分析但是 pkpm 又无法连接时，本技能可以帮助用户连接SAP2000并进行分析
license: Proprietary. 未经许可，严禁披露、复制、逆向还原或复用技能正文、参考资料、脚本及模板。
---

## 工作流

渐进式检索拿到必需的 API 函数 → 连接/启动 SAP2000 → 按用户需求建模、施加荷载、运行分析、提取结果、设计校核。全部通过 Python + comtypes 写脚本完成。

需要可运行代码时读 `use_skill('SAP2000-Link', file='references/common_examples.md')`：最小完整脚本、截面（含 SD 组合截面）、荷载模式与工况、常见坑。

## 查询 API 函数 —— 渐进式检索

**按层级逐步缩小范围，不要一步到位。** 查询脚本在 `scripts/` 目录下，直接执行即可。

### Step 1: 确定一级模块

先判断任务涉及哪个一级模块，一般看概览表即可确定。

| 模块 | 描述 | 典型用途 |
|------|------|----------|
| **File** | 文件操作 | 新建/打开/保存模型文件 |
| **Analyze** | 分析执行 | 运行分析、设置自由度、获取分析状态 |
| **Analysis_Model** | 分析模型 | 分析单元（网格划分后的有限元）操作 |
| **Analysis_Results** | 结果提取 | 节点位移、框架内力、应力、反力等结果 |
| **Definitions** | 模型定义 | 材料、截面、荷载模式、荷载工况、组合定义 |
| **Design** | 设计校核 | 钢结构/混凝土/铝结构设计检查 |
| **Edit** | 编辑操作 | 复制、移动、镜像、删除对象 |
| **General_Functions** | 通用函数 | 启动/退出程序、单位设置、版本信息 |
| **Object_Model** | 对象操作 | 创建/修改几何对象（节点、框架、面、实体等） |
| **Select** | 选择操作 | 选择对象、按组选择、清除选择 |
| **View** | 视图操作 | 刷新视图 |

**Object_Model 常用子模块**：`Object_Model/Point_Object` 节点（坐标、约束、荷载）、`Object_Model/Frame_Object` 框架/梁柱、`Object_Model/Area_Object` 面/墙/板、`Object_Model/Solid_Object` 实体、`Object_Model/Link_Object` 连接单元、`Object_Model/Cable_Object` 缆索、`Object_Model/Tendon_Object` 预应力筋。

**Definitions 常用子模块**：`Definitions/Properties/Frame` 截面定义、`Definitions/Properties/Material` 材料定义、`Definitions/Properties/Frame/SD_Shape` Section Designer 形状、`Definitions/Load_Pattern` 荷载模式、`Definitions/Load_Case` 荷载工况。

**Analysis_Results 常用子模块**：`Analysis_Results/Results` 结果提取函数、`Analysis_Results/Analysis_Results_Setup` 输出工况选择。`Analysis_Results` 本身不挂任何函数，必须下到这两个子模块之一。

**COM 写法 → 检索路径**。库里的模块路径用的是 CSI 文档的章节名，与 Python 里的 COM 属性名不是一回事，照着 COM 名去查会一无所获：

| COM 写法 | 检索路径 |
|----------|----------|
| `SapModel.PointObj` | `Object_Model/Point_Object` |
| `SapModel.FrameObj` | `Object_Model/Frame_Object` |
| `SapModel.AreaObj` | `Object_Model/Area_Object` |
| `SapModel.PropMaterial` | `Definitions/Properties/Material` |
| `SapModel.PropFrame` | `Definitions/Properties/Frame` |
| `PropFrame.SDShape` | `Definitions/Properties/Frame/SD_Shape` |
| `SapModel.LoadPatterns` | `Definitions/Load_Pattern`（单数） |
| `SapModel.LoadCases` | `Definitions/Load_Case`（单数） |
| `SapModel.Results` | `Analysis_Results/Results` |
| `SapModel.Results.Setup` | `Analysis_Results/Analysis_Results_Setup` |
| `SapModel.SelectObj` | `Select` |

查看所有一级模块：
```bash
python scripts/list_top_modules.py
```

### Step 2: 查看模块的子模块

列出指定模块下的**所有子模块（任意层级）**：
```bash
python scripts/list_submodules.py <module_path>

# 示例
python scripts/list_submodules.py Definitions
python scripts/list_submodules.py Definitions/Load_Case
```

### Step 3: 查看模块直接包含的函数

```bash
python scripts/list_module_functions.py <module_path> [--limit N]

# 示例
python scripts/list_module_functions.py Object_Model/Frame_Object
python scripts/list_module_functions.py Select --limit 30
```

子模块名称更贴合任务就继续深入；函数列表里已有所需函数就直接取详情。

### Step 4: 获取函数详细信息

SAP2000 不同类中可能有多个同名函数（如 `GetSelected` 在 8 个模块中都有），必须用**模块路径 + 函数名**精确定位。

```bash
python scripts/get_function_detail.py <module_path> <function_name>
# 示例
python scripts/get_function_detail.py Object_Model/Frame_Object SetLoadDistributed
```

只知函数名时可全文搜索，但这是辅助手段，定位仍应走渐进式检索：
```bash
python scripts/get_function_detail.py --search GetSelected
python scripts/get_function_detail.py --search distributed
```

## 执行铁律

### 1. 永远优先连接已运行的实例

使用 COM 对象前必须先 `comtypes.CoInitialize()`。`GetObject` 在无可用实例时**返回 `None` 而非抛异常**，调用后必须判空。

```python
import comtypes.client
comtypes.CoInitialize()
helper = comtypes.client.CreateObject('SAP2000v1.Helper')
helper = helper.QueryInterface(comtypes.gen.SAP2000v1.cHelper)

sap = helper.GetObject("CSI.SAP2000.API.SapObject")   # 已运行实例
if sap is None:
    sap = helper.CreateObjectProgID("CSI.SAP2000.API.SapObject")
    sap.ApplicationStart()                            # 无实例才启动新的
SapModel = sap.SapModel
```

### 2. 单位制

**所有数值的输入输出都跟随当前单位制，弄错即整套结果差几个数量级。**

- 执行任何任务前先用 `GetPresentUnits()` 确认当前单位制。
- 新建模型统一用 **N_mm_C（9）**；连接到的既有模型按其原设定操作，不要擅自更改。
- `OpenFile` / `NewBlank` / `InitializeNewModel` 会把单位制重置为程序默认值，必须在这三者**之后**再 `SetPresentUnits`，并用 `GetPresentUnits()` 复核。

**eUnits 全表**

| 码 | 单位 | 码 | 单位 | 码 | 单位 | 码 | 单位 |
|----|------|----|------|----|------|----|------|
| 1 | lb_in_F | 5 | kN_mm_C | **9** | **N_mm_C** | 13 | kN_cm_C |
| 2 | lb_ft_F | 6 | kN_m_C | 10 | N_m_C | 14 | kgf_cm_C |
| 3 | kip_in_F | 7 | kgf_mm_C | 11 | Ton_mm_C | 15 | N_cm_C |
| 4 | kip_ft_F | 8 | kgf_m_C | 12 | Ton_m_C | 16 | Ton_cm_C |

```python
SapModel.SetPresentUnits(9)      # 9 = N_mm_C
```

### 3. 文件保存

保存前用 `SapModel.GetModelFilename(True)` 取工程路径；若为 `(Untitled)`，在当前工作目录**新建一个文件夹**再存 `.sdb`。
`InitializeNewModel` / `NewBlank` 会丢弃内存中的当前模型，调用前确认已保存。

### 4. 分析与锁定

- 计算前必须 `SapModel.File.Save(filepath)`，否则取不到结果。
- `RunAnalysis` 后模型被锁定，改模型前要 `SapModel.SetModelIsLocked(False)`。

### 5. 结果提取前置

不选输出工况，所有提取函数返回 0 行。

```python
SapModel.Results.Setup.DeselectAllCasesAndCombosForOutput()
SapModel.Results.Setup.SetCaseSelectedForOutput('TEST')   # 组合用 SetComboSelectedForOutput
```

## ⚠️ VB 示例转 Python 规范

检索到的 API 说明都是 VB 的，写 Python 时必须按下列规则转换，重点是 ByRef（按引用传递）参数。

### 1. ByRef 参数的传入与返回

COM 规定接口方法自身只返回一个 HRESULT，即表示这次调用本身是否成功的状态码。方法要向调用方交付任何数据，只能由调用方先传入指针，方法把结果写进指针指向的内存。类型库（type library）为每个参数记录了方向标记，VB 签名中的 `ByVal` / `ByRef` 就是这些标记在 VB 语法里的写法：

| VB 写法 | 方向标记 | 含义 |
|---------|----------|------|
| `ByVal X` | `[in]` | 纯输入，方法只读取 |
| `ByRef X` | `[in,out]` | 方法会覆盖该位置上的值，新值需交还调用方 |
| 末尾 `As Long` | `[out, retval]` | 同样是输出指针，只是 VB 把它显示成函数返回值 |

Python 没有让被调方改写调用者变量的机制，因此 ctypes 换了个交付方式：按类型库中的方向标记，把每个 `[in,out]` 被写回的新值连同末尾的 `[retval]`，依签名顺序收集成一个序列，作为调用结果返回。HRESULT 不在这个序列里——它指示失败时 comtypes 直接抛出 `COMError`。

**由此得到两条规则**：

- **传入的参数个数** = 签名参数总数。`ByVal` 传真实值；`ByRef` 同样必须占位，传标量 `0`、字符串 `' '` 或数组 `[]` 均可，占位值不影响结果，调用时会被覆盖。带 `Optional` 的可从尾部省略。
- **返回值的个数** = `ByRef` 个数 + 1，排列顺序与签名一致，末位是 `[retval]`。签名中没有 `ByRef` 时不再打包，返回值就是 `[retval]` 本身。

例：`FrameForce` 签名共 16 个参数 = 2 个 `ByVal` + 14 个 `ByRef`，因此传入 16 个、返回 15 个。

`[retval]` 绝大多数声明为 `As Long`，即 SAP2000 自身的状态码 rc：**0 成功，非 0 失败**，每次调用后都要检查。它与 HRESULT 是两回事——COM 调用成功、SAP2000 业务失败是常见组合。库中另有 25 个函数的 `[retval]` 不是 `As Long`，返回的是数据本身：`GetPresentUnits()` 给单位码、`GetModelIsLocked()` 给 True/False、`GetModelFilename()` 给文件名，没有 rc 可查。

### 2. 占位符类型对照表

占位符要写成字面量，不能拿一个尚未定义的变量名去占位。

| VB 类型 | Python 传入 | 示例 |
|---------|------------|------|
| `ByVal String` | `'value'` | `AddByCoord(..., 'BEAM1', ...)` |
| `ByVal Double` | `3.14`（真实数值） | `SetLoadDistributed(..., 1.5, ...)` |
| `ByRef String` | `' '` | `GetPoints(name, ' ', ' ')` |
| `ByRef Double` / `ByRef Long` | `0` | `GetCoordCartesian(pt, 0, 0, 0)` |
| `ByRef Array`（如 `MyName()`） | `[]` | `GetSelected(0, [], [])` |

### 3. 标准调用模板

```vb
'The function returns zero if the selection list is successfully retrieved, otherwise it returns a nonzero value.
Function GetSelected(ByRef NumberItems As Long, ByRef ObjectType() As Long, ByRef ObjectName() As String) As Long
```
```python
# 3 个 ByRef → 传入 3 个占位符，返回 3 + 1 个值
result = SapModel.SelectObj.GetSelected(0, [], [])
# result = (NumberItems, ObjectType, ObjectName, rc)
ret_code = result[3]        # 末位才是状态码
```

### 4. 结果提取函数的返回字段

签名一律以 `get_function_detail.py` 查到的为准，**不要凭对 OAPI 文档的印象传参**。下面四个函数字段最多、查得最频繁，顺序列在这里：

| 调用 | 传入 | 返回 |
|------|------|------|
| `Results.JointDispl(name, 0, 0, []×11)` | 14 | `(NumberResults, Obj, Elm, LoadCase, StepType, StepNum, U1, U2, U3, R1, R2, R3, rc)` |
| `Results.JointReact(name, 0, 0, []×11)` | 14 | `(NumberResults, Obj, Elm, LoadCase, StepType, StepNum, F1, F2, F3, M1, M2, M3, rc)` |
| `Results.FrameForce(name, 0, 0, []×13)` | 16 | `(NumberResults, Obj, ObjSta, Elm, ElmSta, LoadCase, StepType, StepNum, P, V2, V3, T, M2, M3, rc)` |
| `Results.FrameJointForce(name, 0, 0, []×12)` | 15 | `(NumberResults, Obj, Elm, PointElm, LoadCase, StepType, StepNum, F1, F2, F3, M1, M2, M3, rc)` |

## 坐标系与内力符号约定

### 1. 三套坐标系

| 坐标系 | 形式 | 用途 |
|--------|------|------|
| 全局坐标系 | X、Y、Z（右手系，Z 竖直向上为正） | 建模坐标、节点荷载、`JointReact` 反力、`FrameJointForce` 输出 |
| 杆件局部坐标系 | 1、2、3（右手系） | `FrameForce` 内力（P/V2/V3/T/M2/M3）、杆件荷载、截面属性 |
| SD 截面坐标系 | X、Y（截面平面内） | Section Designer 形状定位（XCenter/YCenter） |

### 2. 杆件局部轴默认方向（Ang=0 时）

- **局部 1 轴**：由 I 端指向 J 端（`FrameObj.AddByCoord` 的前一坐标点为 I 端）。
- **水平梁**（沿 ±X 或 ±Y）：**局部 2 轴 = -Z（竖直向下）**，局部 3 轴水平。
- **竖直柱**：**局部 3 轴恒为 +Y**；1 轴=+Z 时局部 2 轴=+X，1 轴=-Z 时局部 2 轴=-X。
- 斜杆：局部 2 轴位于 1 轴与 -Z 组成的平面内（"尽量朝下"）。
- 查询 `[Ang, Advanced, ret] = SapModel.FrameObj.GetLocalAxes(name, 0, False)`，Ang 为绕局部 1 轴的附加转角（从 2 轴转向 3 轴为正，单位度），修改用 `SetLocalAxes`；判断 1 轴指向用 `FrameObj.GetPoints` + `PointObj.GetCoordCartesian` 取两端坐标。

### 3. FrameForce —— 杆件内力（局部坐标系）

- `ObjSta` 为结果位置到 **I 端**的距离；返回行数取决于荷载分布（含 I/J 端及中间点）。
- `P`：**拉为正、压为负**。
- `M3`：使**局部 2 轴正方向一侧受拉**为正（水平梁即下缘受拉为正）；`M2`：使**局部 3 轴正方向一侧受拉**为正。
- `V2/V3`：同一根杆 I、J 两端符号相反。
- 例：简支梁 L=6000、满跨向下 w=10 → V2(I 端)=-30000、M3(跨中)=+4.5e7（=wL²/8）。

### 4. FrameJointForce —— 节点力（全局坐标系）

- 语义：**节点作用于杆端的力/力矩**，即把杆件取作隔离体时两端受到的外力；每根杆返回 I、J 端各一行，`PointElm` 为端点名。
- 分量 F1/F2/F3、M1/M2/M3 为**全局 X/Y/Z 方向**（点单元局部轴默认与全局轴一致），**直接使用，不需要任何符号翻转**。
- 例（+Z 悬臂柱，柱顶 +X 向 10 kN、-Z 向 100 kN）：
  - 柱底行 F=(-10000, 0, +100000)、M=(0, -3.0e7, 0) —— 与柱底支座反力 `JointReact` **相等**；
  - 柱顶行 F=(+10000, 0, -100000)、M≈0 —— 与外加节点荷载**同向相等**，转成 PKPM 节点荷载可直接用，不要反号。

### 5. JointReact —— 支座反力（全局坐标系）

仅约束节点有非零行，数值与同一节点的 `FrameJointForce` 一致。`JointReact('ALL', 2, ...)`（Group 方式）可一次取全部反力做全局平衡校核。

### 6. 选型

要构件内力/内力图（P、V、M）→ `FrameForce`（局部坐标）；要柱底内力、隔离体平衡校核、节点受力 → `FrameJointForce`（全局坐标，可直接矢量叠加）。
