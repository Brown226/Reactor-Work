# 分析装配（工况组合 / 荷载步 / 分析 / 任务指派） — 参考文档（结构·混合路线）


## 概述

**覆盖范围**：`LoadCaseCombine`（工况组合）、`Step`（荷载步）、`Analy`（分析）、
`AnalySetting`（分析参数）、`Job` + `JobManager`（分析任务指派）、`LoadToMassSetting`（荷载转质量）、
`PreStress`/`InitialVelo`/`ElemDeathLive`（初始状态与生死）。

**何时使用**：混合路线要求解结果时（纯几何路线**不建分析**——见下）。

> ★ **路线结论（2026-10-12 实测）**：
> 1. **分析与任务一律写在 `FemModel.fromViewer()` 之后**。实测几何阶段即使建了 `Analy`，
>    网格后 `Analy.all()` 只剩软件自动生成的默认分析「分析-1」；
> 2. **不指派任务 = 结果全 0**：`submitAndSolve()` 只算 `JobManager` 指向的当前任务，
>    而默认「分析-1」只含一个空荷载步 `step-1`（`nCase=0`）→ 位移/反力全 0，
>    但 `run_script` 仍返回 `success:true`、日志仍写"任务执行成功!"（`references/stru/known_issues.md` #51）；
> 3. `LoadToMassSetting`（模态/地震的质量源）是**网格设置**，必须写在几何阶段
>    `StruModel.toViewer()` **之前**（见 `mesh.md`）。

## 核心 API

### 装配链（背下来，最后两步不是可选项）

```text
LoadCase(name) → .add(荷载)                       # 见 loads.md
   → LoadCaseCombine(lid=工况id, coef=系数)
   → Step(name=..., loadCases=[...])              # 一个荷载步 = 一组工况组合
   → Analy(name=..., steps=[...], setting=AnalySetting(...))
   → Job(name=..., main=分析索引)
   → JobManager(main=同索引, pre=job.pre, uid=job.uid, jobs=[job])
   → FemModel.toViewer() → FemModel.submitAndSolve()
```

### 实测签名（pypcae 2.1.0）

```python
LoadCaseCombine(lid, coef=1.0, subType=0, PSDCurve=-1)     # ★ 首参名是 lid（不是 iCase）
#   ⚠️ 手册 2026-10-14 版只列 (lid, coef=1.0, PSDCurve=-1)，**漏列 subType**；
#   2026-10-15 实机探针确认运行时**接受** subType=0（求解正常结束、61_LoadStep.inp 步名为自建 Step_LL）
#   ⇒ 以运行时签名为准（ERRATA #118）；不确定时省略 subType 亦可（有默认值）
Step(name='', changes=None, loadCases=None, nSubstep=1, sTime=1.0, keyInherit=0)
Analy(name='', setting=None, steps=None, stepFatigue=None, spectrumCurve=None,
      psdCurve=None, preStresses=None, initialVelos=None, initialTems=None, initialFluids=None)
AnalySetting(...)                                          # 见下表；非静力必配
Job(name='', main=0, pre=-1, uid=None)                     # main = 分析在 Analy.all() 中的索引
JobManager(main=0, pre=-1, uid=None, jobs=None)            # 指定当前分析任务
LoadToMassSetting(loadToMassParas=None)                    # ★ 几何阶段，[[工况id, 系数], ...]
```

- `Step.add(v)` / `Analy.add(v)` 也存在（返回 self，可链式），但**优先用构造参数**（与手册签名一致）；
- ★ 核对手段：`Analy.all()`（可读 `.name`）、`LoadCase.all()`、`Fixed.all()` 可用；
  **`Step.all()` 抛 `Exception('not implemented')`、`Job` 没有 `.all()`、`Step` 实例没有 `.id`**
  → 核对荷载步请读 `genfea-compute*/61_LoadStep.inp`（#57）。

### `AnalySetting` 必配参数（按分析类型，背下来）

| 目的 | `anaType` | 必配参数 | 附加对象 / 备注 |
|---|---|---|---|
| 线性静力 | `AnaType.STATIC` | 可**不传 `setting`**（默认即线性静力，`iNLType=NLType.ALinear`） | 荷载步 |
| 非线性静力（含接触） | `AnaType.STATIC` | `iNLType=NLType.GeoNonlinear / MaterNonlinear / GeoMaterNonlinear / PDelta` | 多 `Step` 分级加载 |
| 模态 | `AnaType.MODAL` | **`nModal`**（默认只有 3 阶！） | 质量源：`density` + 几何阶段 `LoadToMassSetting`；**可不挂荷载步** |
| 屈曲 | `AnaType.BUCKLING` | `nModal`、`iNLType` | 需预加荷载步 |
| 极限承载力 | `AnaType.POSTBUCK` | `maxLoadCoef`、`dLamRef`、`iDispKey=LimitDispControl.*`、`maxDispCoef` | 荷载步 |
| 隐式动力（时程） | `AnaType.IMPLICIT` | `iType=ImpAnaMethod.*`、`sTime`、`stepLen`、`iDampType=AnaDampType.*`、`dampRatio`（Rayleigh 还要 `freq=[f1,f2]`） | 时程荷载 |
| 显式动力 | `AnaType.EXPLICIT` | `iType=ExAnaMethod.*`、`sTime`、`stepLen` | 时程荷载 |
| 谐响应 | `AnaType.HARMONIC` | ★ 构造参数 `minFreq/maxFreq/nPoints` **对求解器无效** → 必须构造后赋值 `setting.freqArray=[...]`、`setting.nFreq=len(...)` | 不给时 `*forcingFreq 0`，算不出结果 |
| 标准谱 | `AnaType.SPECTRUM` | `iType=SpectrumAnaMethod.Standard`、`iCombine=ModalCombine.*`、`nModalSpectrum`、`minMassCoef` | `SpectrumCurve` |
| 规范谱（抗震） | `AnaType.SPECTRUM` | `iType=SpectrumAnaMethod.Code`、`intensity=SeismicIntensity.*`、`seismicLevel=SeismicLevel.*`、`siteType=SiteClass.*`、`iGroup=DesignEarthquakeGroup.*`、`iDampType`、`dampRatio`、`direction=[1,0,0]` | ★ **必须至少挂一个荷载步**，否则报 `未定义加载步信息`（补一个 DL 自重步即可，谱分析忽略静力荷载本身） |
| 随机振动 | `SPECTRUM`（无独立 anaType） | ★ **2026-10-22 晚版手册新增 14 个 `AnalySetting` 参数**（RMS/响应PSD/模态选择/阻尼给定） | `SelfSpectrum`/`CrossSpectrum`/`PSDCurve`；⛔ **仍不可脚本化**，见下「随机振动（响应谱）参数与现状」 |

`AnaType` 全 14 值：`STATIC / MODAL / IMPLICIT / BUCKLING / EXPLICIT / HARMONIC / SPECTRUM /
POSTBUCK / FATIGUE / STEADYHEAT / TRANSIENTHEAT / STEADYFLUID / TRANSIENTFLUID / SUSPBRIDGEANALY`。
`NLType` 6 值：`ALinear / PDelta / GeoNonlinear / MaterNonlinear / GeoMaterNonlinear / FoundationRaft`。

> **子步不生效（静力与动力均同）**：`Step.nSubstep` 只是程序内置分段，**对结果输出没有任何作用**——
> 想靠子步拿中间结果点是无效的。**但子步会影响非线性求解的加载/卸载路径**（见下「★ 卸载 / 回弹」：折线本构 `nSubstep=1` 不收敛）。
> - 静力要力-位移曲线：**建多个 `Step` 逐级加载**，从每步的反力/位移取点；
> - 隐式动力：计算步数 = `sTime` ÷ `stepLen`，但**输出帧数由全局设置「结果输出间隔」决定**
>   （`Setting.interval` / 界面"设置→输出控制"），与计算步数不是一回事；
> - **时间参数三处自洽**：`AnalySetting.sTime`/`stepLen`、`Step.sTime`、`Step.nSubstep`（≈ sTime/stepLen），
>   且实际计算时长还受荷载步作用时间限制（取小值）。

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
> 实测数据与探针见 `references/stru/known_issues.md` 本条（fem #162 / stru #162）与 `references/stru/interactions.md` §5「卸载写法对照」。

## 代码模板

### 模板 1：线性静力（DL / LL 独立 + 包络步）

```python
# —— 几何阶段：荷载按构件号布（见 loads.md），并写好网格设置 ——
lc_dl = LoadCase("DL"); lc_dl.add(Emload(value=9.81, dir=[0, 0, -1]))       # 留空 geids = 全局
lc_ll = LoadCase("LL"); lc_ll.add(Elload(geids=[beam_set.id],
                     type=LoadDistributionType.Uniform, subType=LoadSubType.Force,
                     value=[20000.0], iCoord=CSYS.GlobalSystem, dir=[0, 0, -1]))
MeshParams(sizer=Size(isBasic=True, basicSize=0.5), toQuad="true")
StruModel.toViewer(); StruModel.submitAndMesh(); FemModel.fromViewer()

# —— 有限元阶段：组合 → 步 → 分析 → 任务 ——
ANALY_NAME = "Static_1"
step_dl  = Step(name="Step_DL",  loadCases=[LoadCaseCombine(lc_dl.id, 1.0)])
step_ll  = Step(name="Step_LL",  loadCases=[LoadCaseCombine(lc_ll.id, 1.0)])
step_all = Step(name="Step_ALL", loadCases=[LoadCaseCombine(lc_dl.id, 1.0),
                                            LoadCaseCombine(lc_ll.id, 1.0)])
analy = Analy(name=ANALY_NAME, steps=[step_dl, step_ll, step_all])          # 不传 setting = 线性静力

main_idx = [a.name for a in Analy.all()].index(ANALY_NAME)                  # ★ 动态取索引
job = Job(name="Job_1", main=main_idx)
JobManager(main=main_idx, pre=job.pre, uid=job.uid, jobs=[job])
FemModel.toViewer(); FemModel.submitAndSolve()
# 核对：genfea-compute*/61_LoadStep.inp 应为 *loadStep 3、步名 Step_DL/Step_LL/Step_ALL
```

### 模板 2：模态分析（质量源在几何阶段，分析在有限元阶段）

```python
# —— 几何阶段 ——
lc_dl = LoadCase("DL"); lc_dl.add(Emload(value=9.81, dir=[0, 0, -1]))
LoadToMassSetting(loadToMassParas=[[lc_dl.id, 1.0]])        # ★ 必须在 toViewer() 之前
MeshParams(sizer=Size(isBasic=True, basicSize=0.5), toQuad="true")
StruModel.toViewer(); StruModel.submitAndMesh(); FemModel.fromViewer()

# —— 有限元阶段 ——
ANALY_NAME = "Modal_10"
step_dl = Step(name="Step_DL", loadCases=[LoadCaseCombine(LoadCase.all()[0].id, 1.0)])
analy = Analy(name=ANALY_NAME, steps=[step_dl],
              setting=AnalySetting(anaType=AnaType.MODAL, nModal=10))       # 非静力必配 setting
main_idx = [a.name for a in Analy.all()].index(ANALY_NAME)
job = Job(name="Job_Modal", main=main_idx)
JobManager(main=main_idx, pre=job.pre, uid=job.uid, jobs=[job])
FemModel.toViewer(); FemModel.submitAndSolve()
# sanity：前 6 阶 ≈0 ⇒ 约束不足（刚体模态）；总质量 ≈ 自重/g + 荷载转质量部分
```

> **实测确认（2026-10-12，pypcae 2.1.0）**：几何阶段建的 `LoadCase` 带入后 `.id` 仍可直接用
> （`LoadCase.all()` → `names=['DL']`、`ids=[0]`）；`Analy.all()` 返回 `['分析-1', <自建分析>]`，
> 所以 `main_idx` 通常是 **1**（务必用 `.index(名称)` 动态取，不要硬编码）；
> 指派成功后 `61_LoadStep.inp` 为 `*loadStep 1` / `1 1 1 1 0 Step_DL` / `1 1 0`（nCase=1、numLoad=1、coef=1），
> 6 m 简支梁自重算例 ΣRz = 83169.20 N 与理论 ρ·A·L·g = 83169.18 N 完全平衡。

### 模板 3：规范谱（抗震）—— 混合路线

```python
# 几何阶段：自重工况 + 荷载转质量（质量源），并写好网格设置
lc_dl = LoadCase("DL"); lc_dl.add(Emload(value=9.81, dir=[0, 0, -1]))
LoadToMassSetting(loadToMassParas=[[lc_dl.id, 1.0]])          # ★ 必须在 toViewer() 之前
MeshParams(sizer=Size(isBasic=True, basicSize=0.5), toQuad="true")
StruModel.toViewer(); StruModel.submitAndMesh(); FemModel.fromViewer()

# 有限元阶段
step_dl = Step(name="Step_DL", loadCases=[LoadCaseCombine(LoadCase.all()[0].id, 1.0)])  # ★ 谱分析也要挂步
analy = Analy(name="SpectrumX", steps=[step_dl], setting=AnalySetting(
    anaType=AnaType.SPECTRUM, iType=SpectrumAnaMethod.Code,
    intensity=SeismicIntensity.Eight, seismicLevel=SeismicLevel.Frequent,
    siteType=SiteClass.Class2, iGroup=DesignEarthquakeGroup.Group1,
    iDampType=AnaDampType.RatioToMass, dampRatio=0.05, direction=[1.0, 0, 0]))
main_idx = [a.name for a in Analy.all()].index("SpectrumX")
job = Job(name="Job_Spec", main=main_idx)
JobManager(main=main_idx, pre=job.pre, uid=job.uid, jobs=[job])
FemModel.toViewer(); FemModel.submitAndSolve()
# sanity：前 6 阶不为 0；累计质量参与系数 ≥ 90%
```

### 模板 4：隐式动力（时程）

```python
# 几何阶段：时程荷载 Wload 按构件号布（会随网格映射为单元号），或留到 FEM 阶段按单元号布
st = Step(name="Seismic", loadCases=[LoadCaseCombine(lc_eq.id, 1.0)],
          nSubstep=2000, sTime=20.0)
analy = Analy(name="TimeHist", steps=[st], setting=AnalySetting(
    anaType=AnaType.IMPLICIT, iType=ImpAnaMethod.Direct,
    sTime=20.0, stepLen=0.01,
    iDampType=AnaDampType.Rayleigh, dampRatio=0.05, freq=[f1, f2]))
# 之后同样 Job + JobManager → toViewer → submitAndSolve
# 时程曲线格式：SpectrumCurve.timeHist / Wload.timeHist 都是 N 行 2 列 [[t1,v1],[t2,v2],...]
```

### 模板 5：单元生死（施工模拟）—— 只能在有限元阶段（`geids` 是单元号）

```python
stage2 = [e.id for e in Element.all() if e.dimension == 2 and <第二期板判据>]
step1 = Step(name="Stage_1",
             changes=[Change(type=ChangeType.Remove, chType=ChangeChType.Element, geids=stage2)],
             loadCases=[LoadCaseCombine(lc_dl.id, 1.0)])
step2 = Step(name="Stage_2",
             changes=[Change(type=ChangeType.Add, chType=ChangeChType.Element, geids=stage2)],
             loadCases=[LoadCaseCombine(lc_dl.id, 1.0)], keyInherit=1)   # 继承前一步
analy = Analy(name="Construction", steps=[step1, step2])
```

### 多任务：`Job` / `JobManager` 索引语义（易错，逐条照做）

- `Job.main`：该任务对应的 **`Analy` 在 `Analy.all()` 中的索引**（第 N 个 → `main = N-1`）；
  ★ 混合路线里 `Analy.all()` 第 0 个恒为软件自动生成的「分析-1」，自建分析通常从 **1** 开始 →
  用 `.index(ANALY_NAME)` 动态取，**不要硬编码**；
- `Job.pre`：预分析的 `Analy` 索引，默认 `-1`（关闭）；仅动力分析可设预分析，且预分析只能是静力；
- `Job.uid`：`main=0` 时 `uid=None`；`main>0` 时是**长度 6 的随机码**（任务唯一标识）；
- `JobManager.main/pre/uid`：**由所选任务决定**——把 `jobs` 里第 N 个任务设为当前任务就写
  `main=jobs[N-1].main, pre=jobs[N-1].pre, uid=jobs[N-1].uid`；
- 一个 `Analy` 配一个 `Job`，个数不限；切换任务只改 `JobManager`，`Job` 不必重建；
- ★ **执行语义**（~~实测 v2026.8.2~~ ★ **2026-10-22 实机复核更正**，环境 v2026.10.1.14_4 / pypcae 2.2.0）：
  一次 `submitAndSolve()` 只算**当前任务**（成立：`sep-processor` 只导出当前任务的 inp，如只有 `42_StaticAnaly.inp`）；
  ~~且脚本进程在首次 submit 后即结束——同脚本内顺序多次提交无效~~ ⇒ **实测同脚本两次提交各跑一条完整管线**
  （两条 `sep-processor→genfea→result-processor`，分别落在 `genfea-compute-<job.uid>`；源码
  `Submit.modelcheck_and_submit()` 为同步全链）。⚠️ **新风险**：`run_script` 返回码**只反映最后一次**管线，
  **前一次的失败会被掩盖** ⇒ 同脚本多次提交时须**逐目录核对产物**（`docs/ERRATA.md` #126）。
  要算完多个分析仍**推荐**：**单脚本定义多 `Analy` + 多 `Job`，顶部留开关常量 `CUR_TASK` 切换 `JobManager`，
  同一脚本运行多次**（每次一条管线、返回码可信）：

```python
CUR_TASK = 0                     # ★ 每次运行前只改这个常量：0=静力, 1=模态
jobs = [Job(name="Job_Static", main=idx_static), Job(name="Job_Modal", main=idx_modal)]
j = jobs[CUR_TASK]
JobManager(main=j.main, pre=j.pre, uid=j.uid, jobs=jobs)
```

#### ★ 按物理场景拆分析（多 `Analy` + `CUR_TASK` 分次提交）完整骨架（2026-10-15 实测）

**何时拆**：同一模型要跑**物理性质不同**的工况组（如 储料静力 / 静水压力 / 模态 / 谱），
拆成多个 `Analy` 比塞进一个分析的多 `Step` 更清晰，且**各任务产物互不污染**。

**实测**：原 7 荷载步单分析 → 拆为「储料 5 步」+「水压 2 步（`Step_WP`/`Step_DLWP`）」两个分析，
两次运行各得**独立的 `genfea-compute-*` 目录**，互不污染。

```python
CUR_TASK = "STORE"                       # ★ 每次运行前只改这个常量："STORE" / "WP"

# —— 分析 1：储料静力（5 个荷载步）——
an_store = Analy("Analy_Store")
for st in (step_dl, step_s1, step_s2, step_s3, step_all_store):
    an_store.add(st)
# —— 分析 2：静水/液压力（2 个荷载步）——
an_wp = Analy("Analy_WP", setting=AnalySetting(anaType=AnalyType.StaticAnalysis))
an_wp.add(step_wp); an_wp.add(step_dlwp)

# —— 每个分析配一个 Job；索引必须动态取 ——
names = [a.name for a in Analy.all()]    # ★ 索引 0 恒为自动生成的「分析-1」，自建分析占 1、2…
idx_store = names.index("Analy_Store")
idx_wp    = names.index("Analy_WP")
jobs = [Job(name="Job_Store", main=idx_store), Job(name="Job_WP", main=idx_wp)]
j = jobs[0] if CUR_TASK == "STORE" else jobs[1]
JobManager(main=j.main, pre=j.pre, uid=j.uid, jobs=jobs)

FemModel.toViewer(); FemModel.submitAndSolve()   # 一次只算 CUR_TASK 指向的那个任务
```

**三条纪律**：
1. `Analy.all()` **索引 0 恒为软件自动生成的「分析-1」**，多分析时自建分析占 1、2… ⇒
   **必须 `[a.name for a in Analy.all()].index(name)` 动态取**，硬编码必错（#51 同源）；
2. 一次 `submitAndSolve()` **只算当前任务**，同脚本改 `CUR_TASK` 常量重跑（见上「执行语义」）；
3. 每次运行**新建一个 `genfea-compute-<随机后缀>` 目录**、失败目录不清理 ⇒
   核对产物前必须先按 `mtime` + `nNode/nElem` **锁定本次目录**
   （见 `references/platform_tools.md`「锁定本次计算目录」；⛔ 按目录名排序或随手取第一个会读到上一轮失败版本）。

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
> 详见 `references/stru/known_issues.md`（技能一 #137 / 技能二 #143）。**跑任何示例前先确认这两处已由厂商修复。**

### 预应力 / 初始速度（有限元阶段，`geids` 是单元号）

```python
PreStress(geids=cable_eids, type=PreStressType.Stress, value=5.0e6)   # ★ 需几何非线性才起作用
InitialVelo(gnids=impact_nids, velo=[vx, vy, vz])                     # 仅动力分析
analy = Analy(name="PStress", steps=[...], setting=AnalySetting(anaType=AnaType.STATIC,
              iNLType=NLType.GeoNonlinear))
```

## 最佳实践

1. **分析与任务一律写在 `FemModel.fromViewer()` 之后**（几何阶段建的不会带入，实测网格后只剩「分析-1」）；
2. **装配链最后两步（`Job` + `JobManager`）不是可选项**——漏掉就是"跑成功但结果全 0"（#51）；
3. **多荷载步用多个 `Step`**：需要力-位移曲线时逐级加载，别指望 `nSubstep`（不生效）；
4. **DL / LL / WL / TEM 独立工况 + 一个 `Step_ALL` 包络步**，便于单独看效应也看组合；
5. 非静力分析**必须**传 `setting=AnalySetting(...)` 且必配参数齐全（模态 `nModal`、谱的烈度参数、
   时程的 `sTime`/`stepLen`/阻尼）；
6. **模态/谱/随机振动的质量源在几何阶段**：`LoadToMassSetting(loadToMassParas=[[工况id, 系数], ...])`
   必须写在 `StruModel.toViewer()` **之前**（写在之后静默无效，#19）；
7. **谱分析与随机振动必须至少挂一个荷载步**，否则报 `未定义加载步信息`（补 DL 自重步即可）；
8. 生死（`Change`）、预应力（`PreStress`）、初速度（`InitialVelo`）都要在 FEM 阶段按**单元号/节点号**给，
   通过 `Analy(steps=[...])` / `Step(changes=[...])` 挂进去；
9. 多任务用 `CUR_TASK` 开关分次提交（一次 `submitAndSolve()` 只算一个任务）；
10. 求解后**先做 `verification.md` 第 0 层自检**（`61_LoadStep.inp` 步名与 `nCase`、`cells>0`、
    ΣRz 平衡），再谈结果对不对。

## 常见错误

| 现象 | 原因 | 修复 |
|---|---|---|
| 位移/反力/应力**全为 0**，日志却"任务执行成功!" | ★ 没建 `Job`+`JobManager`，算了默认空分析「分析-1」 | 补装配链最后两步；核对 `61_LoadStep.inp` 步名不是 `step-1` |
| `61_LoadStep.inp` 里 `*loadStep 1`、`nCase=0`、步名 `step-1` | 同上（空步） | 同上 |
| `Analy` 参数错位 / 分析没建起来 | `steps` 传到了第 2 个位置参数（那是 `setting`） | 关键字：`Analy(name=..., steps=[...])` |
| `LoadCaseCombine(iCase=..., coef=...)` 报 TypeError | ★ 首参名是 `lid` | `LoadCaseCombine(lc.id, 1.0)` |
| `Step.all()` 抛 `Exception('not implemented')` | 该方法未实现（`Job` 也没有 `.all()`、`Step` 没有 `.id`） | 用 `Analy.all()` 核对分析，用 `61_LoadStep.inp` 核对步 |
| 模态只出来 3 阶 | `nModal` 默认 3 | 按需调大；关注累计有效质量系数（平动一般 90%） |
| 模态前 6 阶 ≈0 Hz | 约束不足（刚体模态）或质量源缺失 | 补约束；几何阶段加 `LoadToMassSetting` |
| 模态质量偏小 | `LoadToMassSetting` 写在 `toViewer()` 之后（静默无效） | 移到之前（#19） |
| 谱分析报 `未定义加载步信息` | 谱/随机振动没挂 `Step` | 补一个 DL 自重步 |
| 谱分析无结果 | 标准谱缺 `SpectrumCurve`；规范谱缺烈度/场地/分组参数 | 按上表补齐 |
| 谐响应无结果或崩溃 | 只给了 `minFreq/maxFreq/nPoints`（对求解器无效） | 显式 `setting.freqArray=[...]`、`setting.nFreq=len(...)` |
| 时程时长不对 | 只看 `AnalySetting.sTime`，忽略荷载步作用时间 | 实际时长取两者较小值；三处时间参数自洽 |
| 时程输出帧数不够 | 以为 `nSubstep` 决定输出 | 输出帧数由全局「结果输出间隔」决定 |
| 静力只出一个结果点，画不出曲线 | 误以为子步会产生中间结果 | 建多个 `Step` 逐级加载 |
| 预应力不起作用 | 没开几何非线性 | `AnalySetting(iNLType=NLType.GeoNonlinear)` |
| 多任务只算了一个分析 | 同脚本多次 `submitAndSolve()` 时**前一次的失败被返回码掩盖**（★ 2026-10-22 更正：两次都会跑，返回码只反映最后一次，#126） | `CUR_TASK` 开关分次提交（推荐）；或**逐目录**核对产物而非只看返回码 |
| `JobManager.main` 写了 `Analy` 索引却不生效 | `main/pre/uid` 应"由所选任务确定" | `main=jobs[N-1].main, pre=jobs[N-1].pre, uid=jobs[N-1].uid` |
| 接触/非线性不收敛 | 一步加载、迭代参数默认 | 分级 `Step`；`iNLType` 选对；必要时调收敛容差/弧长法 |

## 验证清单

- [ ] **卸载/回弹**：折线本构用 `keyInherit=1` + 系数 `-1.0` + `nSubstep≥2`（线性本构不必）；`61_LoadStep.inp` 已核对 `keyInherit` 与 `coefLoad`
- [ ] 分析与任务全部写在 `FemModel.fromViewer()` 之后
- [ ] 装配链完整：`LoadCase` → `LoadCaseCombine(lid, coef)` → `Step(loadCases=[...])` →
      `Analy(steps=[...])` → `Job(main=索引)` → `JobManager(...)`
- [ ] `Job.main` 用 `Analy.all().index(ANALY_NAME)` 动态取得（默认「分析-1」占索引 0）
- [ ] 非静力分析已传 `setting=AnalySetting(...)`，必配参数齐全（模态 `nModal`、谱烈度参数、时程时间参数）
- [ ] 模态/谱的质量源 `LoadToMassSetting` 写在几何阶段 `toViewer()` 之前
- [ ] 谱分析/随机振动已挂至少一个荷载步
- [ ] 需要曲线时用多个 `Step`（未依赖 `nSubstep`）；多任务用 `CUR_TASK` 分次提交
- [ ] 求解后核对 `61_LoadStep.inp`（步数/步名/`nCase`）与 `o62_ReactionForce.out`（ΣRz = 总荷载）
