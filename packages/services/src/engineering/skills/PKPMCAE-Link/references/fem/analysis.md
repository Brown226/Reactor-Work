# 分析 — 参考文档




## 概述

分析配置三层结构：`Step`（荷载步）→ `Analy`（分析）→ `Job/JobManager`（任务）。
**非静力分析必须传 `AnalySetting`**。模态分析与规范谱分析可不定义荷载步。

## 分析类型 → 必配参数对照（背下来）

| 目的 | `anaType` | 必配参数 | 附加对象 |
|---|---|---|---|
| 静力 | `STATIC` | `iNLType`（默认 `NLType.ALinear`） | 荷载步 |
| 模态 | `MODAL` | `nModal`（待求特征值个数，默认 3） | 可无荷载 |
| 屈曲 | `BUCKLING` | `nModal`、`iNLType` | 荷载步（预加荷载） |
| 隐式动力 | `IMPLICIT` | `iType=ImpAnaMethod.*`、`sTime`、`stepLen`、`iDampType`、`dampRatio` | 时程荷载 |
| 显式动力 | `EXPLICIT` | `iType=ExAnaMethod.*`、`sTime`、`stepLen` | 时程荷载 |
| 谐响应 | `HARMONIC` | `minFreq`、`maxFreq`、`nPoints`（+`freqOpt`/`HarBias`） | 荷载 + 频率范围 |
| 标准谱 | `SPECTRUM` | `iType=SpectrumAnaMethod.Standard`、`iCombine`、`nModalSpectrum`、`minMassCoef` | `SpectrumCurve` |
| 规范谱 | `SPECTRUM` | `iType=SpectrumAnaMethod.Code`、`intensity`、`seismicLevel`、`siteType`、`iGroup`（+`gAcce`/`alphaMax`/`Tg`/`direction`） | — |
| 极限承载力 | `POSTBUCK` | `maxLoadCoef`、`dLamRef`、`iDispKey`、`maxDispCoef` | 荷载步 |
| 随机振动 | `SPECTRUM`（无独立 anaType） | ★ **2026-10-22 晚版手册新增 14 个 `AnalySetting` 参数**（RMS/响应PSD/模态选择/阻尼给定） | `SelfSpectrum`/`CrossSpectrum`/`PSDCurve`；⛔ **仍不可脚本化**，见下「随机振动（响应谱）参数与现状」 |

`AnaType` 全 14 值：`STATIC / MODAL / IMPLICIT / BUCKLING / EXPLICIT / HARMONIC /
SPECTRUM / POSTBUCK / FATIGUE / STEADYHEAT / TRANSIENTHEAT / STEADYFLUID /
TRANSIENTFLUID / SUSPBRIDGEANALY`

## 核心 API 与模板

### 装配链

```text
LoadCase.add(荷载) → LoadCaseCombine(lid, coef) → Step.add(...) → Analy.add(step)
```

> **`Step` 构造签名（手册 2026-09-28 版起）**：`Step(name, changes=None, loadCases=None, nSubstep=1, sTime=1.0, keyInherit=0)`——`nSubstep` 子步数、`sTime` 作用时间、`keyInherit` 荷载继承模式（0 不继承 / 1 继承），均可在构造时传入或构造后赋值（`st.sTime = 20.0` 写法仍然有效）。

> ⚠️ **子步当前不生效（静力/动力均同，实测版本）**：荷载步的「子步数」/`nSubstep` 仅为程序内置计算时的分段，**对计算结果的显示没有任何作用**——想靠子步获得中间结果点是无效的。**但子步会影响非线性求解的加载/卸载路径**（见下「★ 卸载 / 回弹」：折线本构 `nSubstep=1` 不收敛）。
> - **静力需要力-位移曲线**：创建**多个荷载步（Step）逐级加载**，从每一步的反力/位移结果取点连成曲线；
> - **隐式动力**：计算步数 = 总计算时间 `sTime` ÷ 时间步长 `stepLen`（求解器内部按此推进），但**实际输出的结果帧数由全局设置「结果输出间隔」决定**（设置→输出控制），需要多少帧就配多大间隔，二者别混淆。

### ★ 卸载 / 回弹（2026-10-29 实测：按【本构】分档，不要一刀切）

**第一步永远是判断本构属哪一档**：

| 本构 | 代表写法 | 卸载该怎么写 | 实测结果 |
|---|---|---|---|
| **线弹性** | 连接器 `ConnStiffType.Linear` + `consElas`；材料线弹性 | **任意写都行**：系数 `0.0`，或 `keyInherit=1` + 系数 `-1.0` | ✅ 都收敛、精确回零（`0.000000e+00`）；`nSubstep=1` 也行 |
| **分段非线性弹性** | `ConnStiffType.Nonlinear` + `elastics` 折线表 | ⛔ **必须** `keyInherit=1` + 系数 `-1.0` + `nSubstep ≥ 2`（建议 5~10，与加载步一致） | 系数 `0.0` ⇒ ❌ `子步迭代不收敛.......iIter: 501`；继承+(-1) ⇒ ✅ 回零 |
| **金属弹塑性** | `ConnStiffType.MetalPlastic` + `plastics` + `m` | 两种等价：系数 `0.0`，或 `keyInherit=1` + 系数 `-1.0` | ✅ 两者逐位相同（残余 = 塑性位移、内力 0） |

```python
# 加载步：自身全量
Step("Step_1_load",   nSubstep=10, keyInherit=0).add(LoadCaseCombine(lc.id,  1.0))
# 卸载步：继承上一步 + 系数 -1 抵消（折线本构的唯一可用写法；另两档同样适用）
Step("Step_2_unload", nSubstep=10, keyInherit=1).add(LoadCaseCombine(lc.id, -1.0))
# 部分卸载：净剩 50%
Step("Step_2_half",   nSubstep=10, keyInherit=1).add(LoadCaseCombine(lc.id, -0.5))
```

**`keyInherit` 的语义（踩错就白做）**：`keyInherit=1` ⇒ **本步荷载 = 上一荷载步荷载全量 + 本步组合**；
`keyInherit=0`（默认）⇒ 本步荷载就是全量。⇒ 它是个**叠加器**：`+1.0` 叠加加载、`-0.5` 部分卸载、`-1.0` 卸载到零。

| 反例（均已实机复现） | 实际发生的事 |
|---|---|
| `keyInherit=1` + 系数 `0.0` | ✅ 收敛但**一点没卸载**（荷载被原样继承，位移/内力与上一步相同） |
| `keyInherit=0` + 系数 `-1.0` | ✅ 收敛，但这是**反向加载**（位移、内力全部变号），不是卸载 |
| `keyInherit=1` + 系数 `-1.0` + `nSubstep=1` | ❌ 折线本构下**仍不收敛**（卸载路径没被切分） |

> ⚠️ **`iNLType` 不是原因**：同一材料非线性求解器 + **全线性模型** + 系数 `0.0` + `nSubstep=1` 实测**收敛到 0**；
> 几何非线性（`GeoNonlinear`，小变形）也收敛。⇒ 该坑专属于**分段折线本构**（`elastics`）。
> 未验证：大位移/屈曲工况、动力分析、`Cdisp`/`Ctem` 类荷载是否同样受 `keyInherit` 影响。
> 实测数据与探针见 `references/fem/known_issues.md` 本条（fem #162 / stru #162）与 `references/fem/interactions.md` §5「卸载写法对照」。

### 模板 1：静力（默认，可省 setting）

```python
analy = Analy("StaticAnalysis")
analy.add(Step("Step_ALL").add(LoadCaseCombine(lc_dl.id, 1.0))
                         .add(LoadCaseCombine(lc_ll.id, 1.0)))
```

### 模板 2：模态

```python
analy = Analy("ModalAnalysis",
              setting=AnalySetting(anaType=AnaType.MODAL, nModal=10))
```

> 模态可不挂荷载步；**规范谱实测（v2026.8.2）必须至少挂一个荷载步**，
> 否则报 `未定义加载步信息`——补一个 DL 自重步即可（谱分析忽略静力荷载本身）；
> 随机振动同理。需有效质量系数控制时按用户手册设置（平动一般 90%）。

### 模板 3：规范谱（抗震）

```python
analy = Analy("SpectrumX", setting=AnalySetting(
    anaType=AnaType.SPECTRUM, iType=SpectrumAnaMethod.Code,
    intensity=SeismicIntensity.Eight, seismicLevel=SeismicLevel.Frequent,
    siteType=SiteClass.Class2, iGroup=DesignEarthquakeGroup.Group1,
    iDampType=AnaDampType.RatioToMass, dampRatio=0.05,
    direction=[1.0, 0, 0]))
```

### 模板 4：隐式动力（时程）

```python
st = Step("Seismic", nSubstep=2000, sTime=20.0)   # 手册 9.28 版起支持构造传入；也可构造后赋值 st.sTime / st.nSubstep
st.add(LoadCaseCombine(lc_eq.id, 1.0))

analy = Analy("TimeHist", setting=AnalySetting(
    anaType=AnaType.IMPLICIT, iType=ImpAnaMethod.Direct,
    sTime=20.0, stepLen=0.01,
    iDampType=AnaDampType.Rayleigh, dampRatio=0.05, freq=[f1, f2]))
analy.add(st)
```

> **时间参数三处自洽**（都要覆盖波的持时）：`AnalySetting.sTime`/`stepLen`、
> `Step.sTime`、`Step.nSubstep`（≈ sTime/stepLen）。实际计算时长还受荷载步作用时间限制。
> 输出帧数与计算步数无关：由全局设置「结果输出间隔」决定（设置→输出控制），按需要的结果点数配置；`Step.nSubstep` 仅为内置分段，不影响输出。
> `SpectrumCurve.timeHist` 与 `Wload.timeHist` 同为 **N 行 2 列** `[[x1,v1],[x2,v2],...]`：
> 第一列时间（谱曲线为频率或周期，由 `iKeyTf` 决定）、第二列对应值。

### 模板 5：谐响应（频率点必须显式给定，实测 v2026.8.2）

```python
setting = AnalySetting(anaType=AnaType.HARMONIC,
                       iDampType=AnaDampType.RatioToMass, dampRatio=0.05)
freq_arr = [0.5 + (50.0 - 0.5) * i / 99 for i in range(100)]
setting.freqArray = freq_arr          # 激励频率点列表（构造后赋值）
setting.nFreq = len(freq_arr)         # 频率点数
analy = Analy("Harmonic", setting=setting)
analy.add(Step("Step_H").add(LoadCaseCombine(lc.id, 1.0)))
```

> ⚠️ 构造参数 `minFreq`/`maxFreq`/`nPoints` 对求解器**无效**（inp 文件标注"无用"）；
> 不给 `freqArray`+`nFreq` 时 `*forcingFreq 0`，谐响应算不出结果。

### 模板 6：屈曲 / 极限承载

```python
Analy("Buckling", setting=AnalySetting(anaType=AnaType.BUCKLING, nModal=5))
Analy("PostBuck", setting=AnalySetting(anaType=AnaType.POSTBUCK,
      maxLoadCoef=10.0, dLamRef=0.1,
      iDispKey=LimitDispControl.DispCoef, maxDispCoef=2.0))
```

### 模板 7：单元生死（施工模拟）

```python
step1 = Step("Construction_1",
             changes=[Change(type=ChangeType.Remove, chType=ChangeChType.Element,
                             geids=stage2_elems)],
             loadCases=[LoadCaseCombine(lc_dl.id, 1.0)])
step2 = Step("Construction_2",
             changes=[Change(type=ChangeType.Add, chType=ChangeChType.Element,
                             geids=stage2_elems)],
             loadCases=[LoadCaseCombine(lc_dl.id, 1.0)])
```

### 模板 8：多任务 Job/JobManager（单任务可整节省略）

**索引语义（2026-09 手册澄清版，易错！）**：

- `Job.main`：该任务对应的 **`Analy` 在分析列表中的索引**（按 `Analy(...)` 创建顺序
  从 0 计）——指定分析列表中第 N 个分析，`main = N-1`；
- `Job.pre`：预分析的 `Analy` 索引，默认 `-1` 关闭（仅动力分析可设预分析，且只能选静力）；
- `Job.uid`：**`main=0` 时 `uid=None`；`main>0` 时 `uid` 为长度 6 的随机码**，
  是分析任务的唯一标识符；
- `JobManager.main/pre/uid`：**由指定的分析任务确定**——要把 jobs 列表中第 N 个任务
  设为当前任务：`main = jobs[N-1].main`、`pre = jobs[N-1].pre`、`uid = jobs[N-1].uid`；
- 一个 `Analy` 配一个 `Job`，个数不限；切换任务只改 `JobManager` 的取值，`Job` 不必重建。

```python
Analy("Static", ...)                                                # 索引 0
Analy("Modal", setting=AnalySetting(anaType=AnaType.MODAL, nModal=10))  # 索引 1

job0 = Job("StaticJob", main=0)                    # main=0 → uid 取默认 None
job1 = Job("ModalJob",  main=1, pre=0, uid="a1b2c3")  # main>0 → uid 为 6 位随机码
jobs = [job0, job1]
# 指定 jobs 中第 2 个任务（模态）为当前任务：
JobManager(main=jobs[1].main, pre=jobs[1].pre, uid=jobs[1].uid, jobs=jobs)
```



> ⚠️ **多任务执行语义**（~~实测 v2026.8.2~~ ★ **2026-10-22 实机复核更正**，环境 v2026.10.1.14_4 / pypcae 2.2.0）：
> 一次 `submitAndSolve()` 只计算**当前任务**（成立：`sep-processor` 仅导出该任务 inp，如仅 `42_StaticAnaly.inp`）；
> ~~且脚本进程在首次 submit 后即结束——同脚本内顺序多次提交无效~~ ⇒ **实测同脚本两次提交各跑一条完整管线**
> （`sep-processor→genfea→result-processor` ×2，分别落在 `genfea-compute-<job.uid>`；源码 `Submit.modelcheck_and_submit()` 为同步全链）。
> ⚠️ **新风险**：`run_script` 返回值**只反映最后一次**管线，**前一次的失败会被掩盖** ⇒ 多任务同脚本提交必须**逐目录**核对产物；
> `fromViewer()` 读回切换仍**不建议**（依赖 `pypcae/pypcae.fem.in`，且**缺文件时静默返回空模型**，见 `references/fem/known_issues.md` #126）。
> **仍推荐**：**单脚本定义多 Analy+多 Job，顶部留开关常量（`CUR_TASK`）切换 JobManager，同一脚本运行多次**（每次一条管线、返回码可信）。
> 详见 `references/fem/known_issues.md` #125。
> 见 `examples/fem/gravity_dam_multi_task.py`、`examples/fem/silo_industrial_hydrostatic_modal.py`（CUR_TASK 开关逐任务提交）。

### 随机振动（响应谱）参数与现状 —— 2026-10-22 晚版 / 修订版手册同步

`AnaType` **没有**独立的随机振动取值（只有 `SPECTRUM` 谱分析），随机振动走 `AnaType.SPECTRUM` + `Analy(psdCurve=[PSDCurve(...)])`。
2026-10-22 晚版手册为 `AnalySetting` 新增 15 项（均与随机振动/响应谱相关）：

> ★ **2026-10-22 修订版手册**把其中 `spectralOut` 的**类型标注**由 `int` 更正为 `list[list[int]]`
> （+12 B = 两次手册体积之差，与其正文「第一维为采样点数，第二维长度为5」一致）——属**官方修正签名与正文的自相矛盾**；
> ⛔ 但**不等于实机可用**：下表末列仍是 2026-10-22 实测结论（构造期拒绝该形状）。

| 参数 | 手册语义 | 实机可构造性（2026-10-22 实测） |
|---|---|---|
| `calcCrtl` | 位移/速度/加速度 **RMS** 计算控制（0 不算 / 1 仅相对 / 2 相对+绝对，默认 `[1,0,0]`） | ✅ 1 维列表可构造 |
| `fCalcCtrl` | 力 RMS 控制（0 / 1 模态力 / 2 全部力，默认 1） | ✅ |
| `spectralOut` | **反应谱输出参数表**（第二维长 5：输出类型 1~6 + iNode/iDof + iNode2/iDof2；两节点不同 ⇒ 算互谱 PSD）★ 修订版手册已把签名由 `int` 更正为 `list[list[int]]` | ⛔ **2 维表抛 `ValueError: 维度超标`** |
| `lFreq` / `uFreq` | 响应 PSD 频率下/上界（-1＝取全部输入谱包络） | ✅ |
| `nPoints` | **响应 PSD 曲线的计算频率点个数**（默认 20；旧文档写「频率点数」，已重定义） | ✅ |
| `bias` | 响应 PSD 频率点分布（仅 `nPoints>3` 有效，默认 3.0） | ✅ |
| `iSpectralType` | ⚠️ **手册正文未给数值语义**（仅出现在签名） | ✅ 可传，但取值含义未知 |
| `selectModeType` / `selectMode` / `selectModeFreq` | 模态选择（-1 全部 / 0 按编号 / 1 按频率区间；后两者为二维表） | `selectModeType` ✅；`selectMode`/`selectModeFreq` ⛔ **2 维表报错** |
| `iTypeD` / `selectModeDamp` / `modeFreq` / `coefDamping` | 阻尼给定（-1 全同 / 0 按编号 / 1 按频率；`coefDamping` 二维表，默认 0.02，类型随 `iDampType`） | `iTypeD`、`modeFreq` ✅；`selectModeDamp`/`coefDamping` ⛔ **2 维表报错** |

> ⛔ **现状：随机振动仍不可脚本化（2026-10-22 实测，勿写成可用）**，三重原因：
> ① 那 5 个声明为 2 维表的参数，构造期即抛 `ValueError: 维度超标`（`normalize_numbers_to_list` 用默认 `expected_dims=1`，
>    与连接器 `dampCoefs`/`elastics`/`plastics` 同一缺陷家族）；
> ② 带 `psdCurve` 的分析在 `sep-modelcheck` 崩溃（属安装包 Python/C++ 版本错配，见下）；
> ③ 早前版本还观察到输入曲线不落盘（`53_PSDCurve.inp` 恒为 `*PSDCurve 0 0`）。
> ⇒ **请在界面中定义随机振动**；厂商修复后按 `verification.md` 重新验证再改口径。

> ⚠️ **环境前置检查（2026-10-22 起必做）**：当前安装包处于「半更新」状态，**任何脚本都跑不了**——
> `pypcae/comp/setting.py`（10-22 14:53）含 py3.9+ 注解、py3.7.9 下 `import` 即失败；且新 Python 写出的模型 JSON
> 含 14 个新键，而 `sep-modelcheck.exe` 仍是 10-08 旧构建 ⇒ 所有模型 modelcheck `0xc0000409`。
> 详见 `references/fem/known_issues.md`（技能一 #137 / 技能二 #143）。**跑任何示例前先确认这两处已由厂商修复。**

### 谱曲线与 PSD

```python
SpectrumCurve(timeHist=[[f...], [val...]], type=SpectrumCurveType.AccSpectrum,
              iMethod=InterpolationType.Linear, iKeyTf=KeyTfType.Freq)

SelfSpectrum(name, curves=[[f...], [val...]], iType=2)   # iType: 0位移 1速度 2加速度 3力 4应力
CrossSpectrum(name, iPSD=1, iPSD2=2, curves=[[f...], [re...], [im...]])
PSDCurve(selfSpectrum=[...], crossSpectrum=[...])
```

### 预应力 / 初始速度

```python
PreStress(geids=[...], type=PreStressType.Stress, value=5.0e6)   # 需几何非线性才起作用
InitialVelo(gnids=[...], velo=[vx, vy, vz])                      # 仅动力分析
```

## 常见错误

| 现象 | 原因 | 修复 |
|---|---|---|
| Analy 参数错位 | steps 传给了第 2 位 setting | 关键字：`Analy("x", steps=[...])` |
| 模态结果只有 3 阶 | nModal 默认 3 | 按需要调大；关注有效质量系数 |
| 谐响应频率点不对 | 未配 minFreq/maxFreq/nPoints | 三参数必填 |
| 动力时长不对 | 只看 sTime，忽略荷载步作用时间 | 实际时长 = min(两者) |
| 谱分析无结果 | 标准谱缺 SpectrumCurve / 规范谱缺烈度参数 | 按对照表补齐 |
| `未定义加载步信息` | 谱分析/随机振动没挂 Step | 补一个荷载步（谱分析忽略静力荷载） |
| 谐响应无结果/崩溃 | 只设了 minFreq/maxFreq/nPoints | 显式 `setting.freqArray=[...]; setting.nFreq=len(...)` |
| 预应力不起作用 | 非线性类型未选几何非线性 | `iNLType=NLType.GeoNonlinear` |
| 求解慢/不收敛 | 非线性迭代参数默认不适用 | 在用户手册"设置→方程求解"调收敛容差/弧长法 |
| 多任务计算对象不对 | `JobManager.main` 直接写了 Analy 索引 | 按手册：`main/pre/uid` 从所选任务取——`jobs[N-1].main/.pre/.uid` |
| 静力只算出一个结果点，画不出力-位移曲线 | 误以为子步会产生中间结果（子步不生效，仅内置分段） | 创建多个荷载步逐级加载，逐步从各步反力/位移取点 |
| 多任务只算了一个分析 | 以为双 `Analy` 就会双算；或**同脚本两次 `submitAndSolve()` 中前一次失败被返回码掩盖**（★ 2026-10-22 更正：两次都会跑，但返回值只反映最后一次，#125） | `submitAndSolve` 每次仅算当前任务；多任务**推荐** `CUR_TASK` 切换分次提交；若确要同脚本多次提交，须**逐目录**核对产物而非只看返回码 |
| 动力输出帧数与预期不符 | 计算步数=sTime/stepLen，但输出帧数由「结果输出间隔」决定 | 在 设置→输出控制 调整结果输出间隔 |
| main>0 的 Job 报身份异常 | 缺 uid | 手册规则：main=0 → uid=None；main>0 → uid=6 位随机码 |

## 验证清单

- [ ] **卸载/回弹**：折线本构（`elastics`）用 `Step(keyInherit=1)` + `LoadCaseCombine(lc, -1.0)` + `nSubstep≥2`；线性/弹塑性可用系数 `0.0`；已在 `61_LoadStep.inp` 核对 `keyInherit=1`、`coefLoad=-1`
- [ ] 非静力分析传了 `setting=AnalySetting(...)` 且必配参数齐全
- [ ] 动力分析材料已填 density；必要时配阻尼
- [ ] 谱分析模态组合方式（CQC/SRSS）与计算模态数已设
- [ ] 多任务时 Job.main 指向正确的 Analy 索引；JobManager 三值取自 jobs[N-1]；main>0 的 Job 已配 6 位 uid
- [ ] 多任务已按"一次提交只算当前任务"规划：开关常量+多次运行（或界面切换），未在同脚本写顺序多次 submit
- [ ] 单元生死的 chType 与 geids 对应（单元/边界）
- [ ] 未依赖子步产出结果点；静力需力-位移曲线时已建多个 Step
- [ ] 动力分析已按需配置「结果输出间隔」（决定输出帧数，非计算步数）
