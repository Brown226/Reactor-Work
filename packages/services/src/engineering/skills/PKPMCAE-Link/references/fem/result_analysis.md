# 结果分析与对话收口 — 参考文档


> 本文件定义**计算完成之后**的强制收口流程与结果分析规则，并附**全部 .out 结果文件的
> 完整字段字典**（源自官方 out 文件格式说明）。读结果时以本文件为准，
> **不需要也不允许**再去翻软件安装目录或源码。

## ⛔ 使用前提（硬禁令，优先级高于本文其余全部内容）

> **坚决禁止 Agent 自行分析结果。只要「模型代码顺利生成 + 执行无报错 + 结果文件已生成」就立即停止交付**，
> 输出 `SUCCESS_WAIT_USER` 交付包，把综合判断交回用户（见 `execution_contract.md` §4b）。
> 1. **本文 §2 的"结果分析模式"默认不进入**：仅当用户明确说"判断结果 / 解读结果 / 诊断 / 帮我核对"时才生效；
>    Agent 不得因为"想确认一下""看起来可疑""顺便验证"就自行进入。
> 2. **本文 §4–§6 的字段字典是"查文件用"的工具书**，不是"自己去分析"的授权：读哪个文件、读哪些字段，
>    以用户的具体问题为限；**禁止**通读全部 `.out` 做自查、禁止多轮"报告 → 再验证 → 再报告"
>    （会烧掉巨量 token，且长对话可能无法保留）。
> 3. **禁止用教科书公式判定软件结果对错**：Agent 对本软件并不完全熟悉，软件的单元定义、符号约定、
>    输出坐标系（总体系/局部系/协调系/伪总体系）、平均算法常与通用公式的前提不同
>    （程序梁含剪切变形 → 挠度比欧拉梁大 2.5%；壳不计横向剪应力；`o43` 的 ave 是先平均分量再算 Mises）。
>    仅在用户明确要求对照时引用，且必须声明"公式与软件定义可能不一致、偏差不等于错误、是否可信请您判断"。
> 4. **只报数值 + 文件出处，不下工程结论**；每出一份报告即停止并再问用户一次。
> **CAE Agent 可以生成结果和辅助判断，但不能替代工程师对结果可信度和工程结论负责。**

## 1. 计算完成后的强制收口流程

提交计算（`submitAndSolve()`）并确认计算成功后，**必须**按以下顺序收口：

```text
1. 验收 + 汇报  先按 execution_contract.md §3 核对验收 8 项（结果文件存在·非空·含所需变量、
              日志无中断无未收敛、warning 全部列出），再轻量汇报：模型摘要 + 计算状态
              + 警告项 + 脚本/日志/结果文件真实路径 → 输出 SUCCESS_WAIT_USER 交付包
              （execution_contract.md §7）
2. 停止并询问用户（原话）：
   "是否需要 Agent 继续分析并优化结果（时间消耗及 token 消耗会更多）？"
3. 按用户选择分支：
   ├─ 不需要 → 结束对话，不再读取任何结果文件
   └─ 需要   → 进入「结果分析模式」（见 §2）
```

> ⚠️ **一次报告一次询问**：结果分析模式下，**每生成一次结果报告就必须停止，
> 再次询问用户**（是否继续深入 / 是否需要调整）。禁止 Agent 自发连续多轮生成
> 结果报告、反复自查自问地"无限思考"；结果的正确性判断权交给用户，
> Agent 只负责提供数值、依据与建议，不做"替用户拍板"式的结论循环。

## 2. 结果分析模式规则（用户确认后才生效）

| 规则 | 内容 |
|------|------|
| 只读文本结果 | **只允许读取文本 `.out` 结果文件**（完整字段字典见 §4-§6，无需其他资料） |
| 禁止二进制 | **绝对禁止强行解析二进制结果文件**（`*.dat`、`history_*.dat`、`o111_InfluenceLine.out`（强制二进制）、`o101_History.out` 的二进制部分）——需要这些量时改用文本 .out 中的对应项，没有就告知用户在后处理界面查看 |
| 禁止翻源码 | **绝对禁止到软件安装目录翻查内部文件/源码**（pypcae 包、resources 等）寻找结果信息；结果问题一律从 .out 文本与日志（log.out / pserver.log）获取 |
| 读取方式 | `live_task` 取项目目录 → 定位 `genfea-compute-*/Out<类型>/` → 文本 `.out` 用 python_executor 读取（大文件只读所需行段）；结果提取平台函数的存在性以当前环境实时清单为准（cae-mcp 模式用 `function_search`，内置模式查系统工具清单，见 `references/platform_tools.md` §0） |
| 报告纪律 | **每生成一次结果报告就停止并询问用户一次**；禁止 Agent 自行无限进入"生成报告→再验证→再报告"的循环；结果正确性由用户判断，Agent 提供依据不替用户下最终结论 |

## 3. 结果文件位置与总则

```text
<项目目录>/genfea-compute-XXXXXX/
├── out.out                ← 当前分析类型标记（一行 *关键字，见 §5.0）
├── log.out                ← 求解日志
└── Out<分析类型>/*.out     ← 文本结果（OutStatic / OutModal / OutBuckling /
                              OutImDyna / OutExDyna / OutHarmonic /
                              OutSpectrum / OutPostBuck，以实际目录名为准）
```

**通用结构**：注释头（`**` 或 `!` 开头说明字段）→ `*关键字 参数行` → 数据区。
绝大多数文件按荷载步循环：`nStep` 步 → 每步一行 `iStep, time` → 步内按节点/单元逐行。

**`time` 列的含义随分析类型变**：静力=加载系数（通常 1.0）；动力=时间(s)；
谐响应=激励频率(Hz)；极限承载=荷载系数。

**单位制**：以 `o10_Additional.out` 的 `*unitSystem` 段为准（逐文件列出单位字符串）；
项目默认 SI（m/N/Pa）。读数前先确认单位制。

**坐标系约定（重要！）**：
- 节点位移/速度/加速度/反力/内力（o11-o13、o61-o65）：**总体系**；
- 单元应力/应变（o21-o24、o41-44）：一维单元=**局部系**，二维单元=**协调系**
  （局部法向为协调 z 轴；法向平行总体 x 轴时协调 y 轴取总体 y 轴），三维单元=**总体系**；
- 节点应力/应变（o31-o35、o51-52）：**伪总体系**——由单元节点值抹平得到，
  节点连接多种单元类型时物理含义失真，引用时须注明；
- `o61_MemberForceLocal` 的杆件内力：**局部系**，且按工程轴力/剪力/弯矩图规则
  （每单元带头行 `iNum, m, y(1:3)`，y 为局部 y 向）。

## 4. 字段字典（通用字段）

| 字段 | 含义 |
|---|---|
| `nStep` / `iStep` / `time` | 输出总步数 / 步号 / 时间·加载系数·频率 |
| `nNum` / `iNum` | 记录总数 / 记录号（节点号或单元号） |
| `nDof` | 每条记录分量数（位移类 2/3/6；热流=3；流体=4或5） |
| `nNode` | 单元的节点数或积分点数；o61 系列中为单元节点数 m |
| `nLayer` | 壳截面层数（其余截面=1） |
| `nMul` | 倍数（通常 1；壳计入上下表面=2；复合梁=复合数） |
| `average` | 平均值列（**暂时关闭输出**，见到忽略） |

**单元应力/应变有效分量数（其余分量为 0）**：

| 单元类型 | 分量数 | 内容 |
|---|---|---|
| 杆/索/梁杆 | 1 | 轴向 |
| 张拉膜 | 2 | 双向正 |
| 梁 | 2 | 轴向 + 扭转剪 |
| 平面应力/板/壳 | 3 | 双向正 + 面内剪 |
| 实体 | 6 | 三向正 + 三向剪 |
| 平面应变/轴对称实体 | 应力 4（多法向正应力）、应变 3 | 法向正应变恒为 0 |
| 轴对称壳（线） | 应力 2、应变 1 | — |

> 壳单元均为薄壳（未计横向剪应力）。

## 5. 结果文件全字典

### 5.0 元信息文件

**`out.out`** — 当前分析类型标记：注释段列出全部类型枚举，正文一行
`*staticAnalysis` / `*modalAnalysis` / `*implicitDynamic` / `*bucklingAnalysis` /
`*explicitDynamic` / `*harmonicAnaly` / `*spectrumAnaly` / `*randomVibration` /
`*postBuckling` / `*steadyHeat` / `*transientHeat` / `*steadyFluid` / `*transientFluid`。
读结果前先读它确认分析类型。

**`o10_Additional.out`** — 附加信息（**建议第一个读**）：
```text
*unitSystem num                → 逐行列出 resName unitStr（各结果文件的单位字符串）
*randomVibraCtrl rmsCtrl(3)    → 随机振动 RMS 控制（位移/速度/加速度：0 不算 1 仅相对 2 相对+绝对）
*loadStepActiveInfo nStep      → 有效荷载步原始编号（荷载步抑制时用于映射）
*fileFormat fileType           → 0=文本 1=二进制（确认结果确为文本再读）
```

### 5.1 节点基本结果（o11-o15）

**`o11_NodeDisp.out`** — 节点位移（**总体系**）：
```text
*nodeDisp nStep,nNum,nDof
每步: iStep, time
  每节点: iNum, disp(1:nDof)     ! nDof=6 时为 Ux,Uy,Uz,Phx,Phy,Phz
```

**`o11_NodeDispHarmonic.out`** — 谐响应节点位移（每节点一行 4 组数）：
```text
*harmonicNodeDisp nStep,nNum,nDof
每步: iStep, freq                ! 激励频率 Hz
  每节点: iNum, aDisp(1:nDof), phase(1:nDof), xDisp(1:nDof), yDisp(1:nDof)
          ! 依次 = 位移幅值、相位角(弧度)、实部位移、虚部位移
```
> 读幅频曲线取 `aDisp`；`phase` 弧度制。

**`o12_NodeVelo.out` / `o13_NodeAcce.out`** — 节点速度 / 加速度（总体系），布局同 o11。

**`o14_NodeTem.out`** — 节点温度：布局同 o11；`nDof` 不考虑摄动温度时为 1；
摄动温度（仅壳）为顶底面温差。

**`o15_NodeFluid.out`** — 节点流场：`value(1:nDof)` = `(vx, vy, vz, p, T)`，nDof=4 或 5。

### 5.2 应变·损伤·失效（o2x 单元 / o3x 节点）

**`o21_ElemElaStrain.out` / `o22_ElemPlaStrain.out`** — 单元弹性/塑性应变（局部系等，见 §3）：
```text
*elemElaStrain nStep,nNum
每步: iStep, time
  每单元: iNum, nNode, nDof, nLayer, nMul
    循环 nMul × nNode × nLayer: strain(1:nDof)   ! 有效分量数见 §4 表
```

**`o23_ElemPeeq.out`** — 单元等效塑性应变：同 o21 布局，`nDof` 恒为 1。

**`o24_ElemDamage.out`** — 单元损伤：同 o21 布局，`nDof` 恒为 2（受拉、受压）。

**`o25_ElemFailure.out`** — 失效单元清单（布局不同！）：
```text
*elemFailure nStep
每步: iStep, time, nNum, nNumGen
  iNum(1:nNum)         ! 完全失效单元号（所有积分点失效）
  iNumGen(1:nNumGen)   ! 广义失效单元号（完全失效 + 仅混凝土失效）
```

**`o26_ElemPeeq<材料>.out`**（Concrete/Rebar/SoilRock/Steel/Unknown）— 分材料等效塑性应变：
```text
*elemPeeqSteel nStep,nNum,numElem
每步: iStep, time
  每单元: iNum, peeqAve, peeqMax, peeqMin
```
> 最值/平均值对各积分点而言：ave=各积分点平均，max/min=各积分点最大/最小。

**`o27_ElemDamageConcrete.out`** — 混凝土损伤：同 o26 布局，
每单元 `iNum, damageAve(1:2), damageMax(1:2), damageMin(1:2)`（受压、受拉）。

**`o31_NodeElaStrain.out` / `o32_NodePlaStrain.out`** — 节点应变（**伪总体系**，6 分量）：
```text
*nodeElaStrain nStep,nNum
每步: iStep, time → 每节点: iNum, strain(1:6)
```

**`o33_NodePeeqDamage.out`** — 节点等效塑性应变/损伤（伪总体系）。

**`o34_NodeDamageConcrete.out`** — 节点混凝土损伤：
```text
*nodeDamageConcrete nStep,nNum,nNumConcrete     ! nNumConcrete=0 时后处理忽略本文件
每节点: iNum, damageAve(1:2), damageMax(1:2)    ! 对该节点相邻单元取平均/最大
```

**`o35_NodePeeq<材料>.out`** — 节点分材料等效塑性应变（布局同 o34 族）。

### 5.3 应力（o4x 单元 / o5x 节点）

**`o41_ElemStress.out`** — 单元应力分量：布局同 o21（`iNum, nNode, nDof, nLayer, nMul`
→ 三层循环输出 `sress(1:nDof)`）；分量数与坐标系规则见 §3/§4。

**`o42_ElemMisesStress.out`** — 单元 Mises 应力：布局同 o21，`nDof` 恒为 1。

**`o43_ElemMises<材料>.out`**（Steel/Concrete/Rebar/SoilRock/Unknown）— 分材料 Mises：
```text
*elemMisesSteel nStep,nNum,numElem
每单元: iNum, misesAve, misesMax
```
> ⚠️ ave 的算法：**先平均各积分点应力分量、再算 Mises**（不是 Mises 的平均）；
> max = 各积分点 Mises 最大值。

**`o44_ElemPrincipalStress.out`** — 单元主应力（取 **Mises 最大的积分点**）：
```text
*elemPrincipalStress nStep,nNum
每单元: iNum, Max, Mid, Min, vect11(1:3), vect22(1:3)
        ! 三个主应力（正拉负压）+ 主应力 s11、s22 的方向矢量
```
**`o44_ElemPrincipalStressAve.out`** — 单元平均主应力（**先平均应力再求主应力**，
不是主应力的平均），布局相同。

**`o45_ElemHeatFlux.out`** — 单元热流：
```text
*elemHeatFlux nStep,nNum
每单元: iNum, nNode, nDof(=3) → 每节点: flux(1:3)
```

**`o51_NodeStress.out`** — 节点应力（**伪总体系**，6 分量）：布局同 o31。

**`o52_NodeMisesStress.out`** — 节点 Mises（平均值）：每节点 `iNum, misesStress`。

**`o53_NodeMises<材料>.out`** — 节点分材料 Mises：
```text
*nodeMisesSteel nStep,nNum,nNumSteel      ! nNumSteel=0 时后处理忽略本文件
每节点: iNum, misesAve, misesMax
```

**`o54_NodeHeatFlux.out`** — 节点热流：每节点 `iNum, flux(1:3)`。

### 5.4 内力与反力（o6x）

**`o61_MemberForceLocal.out`** — 杆系单元节点力（**局部系**，按工程弯矩图/剪力图规则）：
```text
*memberForceLocal nStep,nNum
每步: iStep, time
  每单元: iNum, m, y(1:3)          ! m=单元节点数；y=局部 y 向（读内力符号时参照）
    每节点: force(1:6)             ! 局部系 N,Vy,Vz,T,My,Mz 顺序按工程图规则
```
> 验算温度轴力/弯矩用这个文件。`o61_BeamForceLocal.out` 已**废弃**（内力输出方案改变），
> 见到请改用 `o61_MemberForceLocal.out`。

**`o61_ElemForce.out` / `o61_ElemForceLocal.out`** — 单元节点力（总体系 / 局部系）：
```text
每单元: iNum, m → 每节点: force(1:6)
```
**`o61_ElemForceAve.out`** — 单元平均节点力（暂直接输出 1 号节点值）：每单元 `iNum, forceAve(1:6)`。

**`o62_ReactionForce.out`** — 支座反力（**验算反力平衡用这个**）：
```text
*reactionForce nStep,nFix,nElas
每步: iStep, time
  每固支:     iFix, iNode, rFix(1:n)     ! n=3 或 6
  每弹性支撑: iElas, iNode, rElas(1:n)
! 反力顺序: Rx, Ry, Rz, Mx, My, Mz（总体系）
```

**`o63_ConnectForce.out`** — 连接器内力（总体系，**GBK** 编码）：每连接器 `iNum, m(=2)` →
每节点 `iNode, force(1:6)`。

★ **2026-10-15 实机复核的确切结构**（连接器验证算例，2 个荷载步 / 1 个连接器）：

```text
*connectForce         2         1        ← nStep=2, nConn=1
         1       0.000000E+000           ← iStep=1, time
         1         2                     ← iConn=1, m=2（该连接器的 2 个节点）
                     2      -0.100000E+004   0.000000E+000 ×5     ← iNode=2, Fx,Fy,Fz,Mx,My,Mz
                     3       0.100000E+004   0.000000E+000 ×5     ← iNode=3（★ 与 iNode=2 等值反号 = 作用力/反作用力）
         2       0.000000E+000           ← iStep=2, time
         ...（同上重复）
```

**判读要点**：
- 两端节点的内力**等值反号**（作用力/反作用力），这是连接器正常工作的直观特征；
- ★ **最硬的"连接器确实生效"判据**：让连接器成为**唯一传力路径**（受荷节点不挂任何单元），
  则 `o63` 的内力应**等于全部施加荷载**（实测 `consElas=1e6 N/m`、`Fx=1000 N` → 内力 **±1000 N**，
  偏差 0.0000%）。若内力远小于施加荷载，说明荷载被其它路径旁路了（并非连接器失效）；
- 只有 `iDofs` 里指定的自由度才有非零内力（本例只连 `Ux` → 仅 `Fx` 非零，其余 5 个分量恒 0）；
- ⚠️ 该文件**仅在模型含连接器时生成**；不含连接器时 `OutStatic/` 下没有 `o63_*`。

**`o64_ContactForce.out`** — 接触对内力（总体系，3 分量）：每接触对 `iNum, m` →
`iNode, force(1:3)`；节点顺序**靶在前、源在后**。

**`o65_IsolationForce.out`** — 隔震支座：每支座 `iNum, iNode, force(1:6), disp(1:3)`
（内力总体系 + 底部位移）。

### 5.5 特征值（o7x）

**`o71_EeigenValueModal.out`** — 模态频率（**模态/谱分析验算主文件**）：
```text
*eigenValueModal nNum,totalMass,totalMassBeam,totalMassShell,totalMassNode
每阶: iNum, freq, T, effectMass(1:6)
      ! freq=频率(Hz), T=周期(s)
      ! effectMass 1:3 = x/y/z 各向单阶值, 4:6 = 各向累加值（验算 ≥90% 看 4:6）
```

**`o72_EeigenVectorModal.out`** — 模态振型（已对质量阵归一化）：
```text
*eigenVectorModal nNum,nNode
每阶: iNum → 每节点: iNode, xyz(1:3)
```

**`o73_EeigenValueBuckling.out`** — 屈曲荷载系数：每阶 `iNum, coef`
（屈曲荷载 = coef × 参考荷载）。

**`o74_EeigenVectorBuckling.out`** — 屈曲振型（对单位阵归一化），布局同 o72。

### 5.6 能量与专项

**`o81_TotalEnergy.out`** — 总能量：每步 `iStep, time, alwk, alke, alie`
（外力功/动能/内能；弹性应变能 alse、伪应变能 alae、塑性耗散 alpd、粘性耗散 alvd 暂未输出）。

**`o82_ElemEnergy.out`** — 单元能量密度：每单元
`iNum, elseden, elaeden, elpdden, elkeden, elvdden`
（弹性应变能/伪应变能/塑性耗散/动能/粘性耗散密度）。

**`o91_RPSDCurve.out`** — 随机振动响应 PSD：
```text
*RandomAnaly nStep,nNum
每条曲线: i, iType, iNum1, iDof1, iNum2, iDof2
          ! iType: 1相对位移 2相对速度 3相对加速度 4位移 5速度 6加速度
          ! iNum1=iNum2 且 iDof1=iDof2 → 自谱；否则互谱
  每频点: j, freq, val
```

**`o101_History.out`** — 时程历史输出：**二进制为主**（`history_##id##.dat`，
记录帧数/节点单元编号/结果类型/时间数组/数据数组），**勿解析**；需要时程看 o11/o12/o13。

**`o111_InfluenceLine.out`** — 影响线（移动荷载）：**强制二进制**，勿解析；
此时 o11 等文件荷载步为 1，结果类型为 integer(8)，是本文件中的起始字节位置（≤0 表示取 0）。

**`o121_SuspensionElemPreForce.out`** — 悬索单元预节点力（平衡单元节点力）：
每单元 `iElem, nValue, value(1:nValue)`。

**`o131_ElemStressIntensity.out`** — 单元应力强度：
`inte = max(|s11-s22|, |s22-s33|, |s11-s33|)`；每单元 `iNum, inte`。

**`o141/142/143_StressLinearization*.out`** — 应力线性化（沿路径）：
- o141 应力分量：每请求每分量 `iSCL, iS, np` → 路径点 `x, Stress, StressM(膜), StressB(膜+弯)`；
- o142 Mises：路径点 `x, Mises_S, Mises_M(膜), Mises_B(膜+弯)`；
- o143 主应力：路径点 Max/Mid/Min 各分 S/M/B 三列。

**`o11.NodeFatigue.out`** — 疲劳结果（注意文件名是点号不是下划线）：
```text
*fatigueRes nNode
每节点: iNode, Nf, Fdmg, saftyFactor
! Nf=寿命(循环周次), Fdmg=疲劳累积损伤(与 Nf 成倒数), saftyFactor=Dang Van 安全因子
! 输出所有节点，不参加疲劳分析的节点输出 0
```

## 6. 分析类型 → 优先查看文件与验证抓手

| 分析类型 | out.out 标记 | 关键文件 | 验证抓手 |
|---|---|---|---|
| 静力 | `*staticAnalysis` | o11（位移）、o62（反力）、o61_MemberForceLocal（杆件内力）、o42/o52（Mises） | 反力合计=外荷载合力；位移与理论解对照 |
| 模态 | `*modalAnalysis` | o71（频率+有效质量系数）、o72（振型） | 无零频（约束完备）；effectMass(4:6) 平动 ≥ 90% |
| 屈曲 | `*bucklingAnalysis` | o73（屈曲系数）、o74（振型） | 一阶系数 × 参考荷载 ≈ 欧拉公式 |
| 隐式/显式动力 | `*implicitDynamic` / `*explicitDynamic` | o11/o12/o13（时程）、o81（能量） | 脉冲后自由衰减（阻尼）；主频接近自振频率 |
| 谐响应 | `*harmonicAnaly` | o11_NodeDispHarmonic（幅值 aDisp+相位 phase） | 峰值在自振频率附近；低频段 ≈ 静位移 |
| 谱分析 | `*spectrumAnaly` | o11、o62、o71 | 基底剪力/顶点位排量级 |
| 随机振动 | `*randomVibration` | o91（响应 PSD）、o10（RMS 控制） | PSD 峰值在自振频率附近 |
| 极限承载 | `*postBuckling` | o11（time 列=荷载系数） | 软化趋势、终止荷载系数 |
| 稳态/瞬态热 | `*steadyHeat` / `*transientHeat` | o14（温度）、o45/o54（热流） | 温度场分布合理性 |
| 稳态/瞬态流体 | `*steadyFluid` / `*transientFluid` | o15（流场 vx,vy,vz,p,T） | 场分布合理性 |
| 疲劳 | — | o11.NodeFatigue（Nf/Fdmg/安全因子） | 损伤<1 |
| 移动荷载影响线 | — | o111（**二进制，勿解析**） | 建议界面查看 |

## 7. 结果分析报告要点

- 引用**具体文件路径 + 具体节点/单元号 + 数值**，禁止只说"结果正常"；
- **措辞红线（即便在分析模式下也适用）**：只说"求解正常结束 + 数值与出处"，不下"安全 / 合格 /
  满足规范"这类工程结论——是否可接受由用户（工程师）判断，Agent 提供依据不替代签字
  （`execution_contract.md` §4）；未经用户明确指令，不自动改模型、不自动做参数扫描/优化/重跑（§5）；
- ⛔ **不给物理判断**：不评价量级是否合理、不判定平衡是否满足、不下"对不对"的结论；
  如用户明确要求对照，只报"与 <公式/基准> 的差值 = x.x%"，并声明**公式与软件定义可能不一致、
  偏差不等于错误**（见 `execution_contract.md` §4b）；工程结论与结果可信度由用户（工程师）判定；
- 注意 §3 的坐标系约定与 §4 的有效分量数——梁单元应力只有 2 个有效分量（轴向+扭转剪），
  不要把 6 分量数组里的零值当成"算错了"；
- 优化建议落在建模侧（网格密度、约束方式、参数取值、分析设置），
  **不要**建议用户或自己去翻软件安装目录的内部实现；
- 若文本结果不足以回答（如只有二进制 .dat / 影响线），如实告知用户并建议在后处理界面查看；
- 报告输出后即停止并询问用户；**是否继续分析、结果是否可接受，由用户决定**——
  Agent 不自行进入下一轮报告或"自我验证循环"。
