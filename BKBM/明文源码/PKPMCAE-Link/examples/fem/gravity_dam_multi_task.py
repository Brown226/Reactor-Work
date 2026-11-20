# -*- coding: utf-8 -*-
# 分析类型: 静力 + 规范谱 + 隐式动力时程 (单脚本多任务)
# 模型描述: 混凝土重力坝坝段+岩石地基，八节点实体单元；竖直上游面+斜下游面剖面，矩形地基
# 用户输入参数: DAM_H=60.0(m); DAM_BASE_W=48.0(m); DAM_CREST_W=8.0(m); FD_LEN=160.0(m);
#               FD_THK=20.0(m); FD_DEP=60.0(m); WATER_H=55.0(m); MESH=4.0(m)
# 假设: 线弹性; 坝底与地基共节点连续; 地基底面固结; 不计扬压力与泥沙压力; 单位制 SI(m/N/Pa)
# 任务: Job1 静力(DL+WP) / Job2 规范谱(8度多遇X向) / Job3 隐式时程(基底加速度);
#       当前任务由顶部常量 CUR_TASK(0/1/2) 选择——一次 submitAndSolve 只算当前任务,
#       本脚本按 CUR_TASK=0/1/2 各运行一次即算完三种分析(见 docs/ERRATA.md 已知限制区)
# 验证基准: WP 步基底顺河向反力 ≈ 静水压力合力 0.5*rho*g*H^2*B = 0.5*9810*55^2*20 ≈ 2.97e8 N;
#           规范谱 X 向累计质量参与系数 ≥0.85(实测 0.88, 20 阶 CQC);
#           时程坝顶顺河向位移峰值出现在主振段(1~8 s), 量级 mm~cm, 脉冲结束后衰减
# 单位制: SI(m / N / Pa / kg/m^3)

# ========== 0. 导入 ==========
from pypcae.enums import *
from pypcae.comp import *
from pypcae.fem import FemModel
import math

clc()

# ========== 1. 参数 ==========
CUR_TASK = 0       # 当前分析任务: 0=静力 / 1=规范谱 / 2=隐式动力时程
MESH = 4.0
FD_LEN = 160.0
FD_THK = 20.0
FD_DEP = 60.0
DAM_H = 60.0
DAM_BASE_W = 48.0
DAM_CREST_W = 8.0
UP_X = -24.0
WATER_H = 55.0
RHO_W = 1000.0
G_GRAV = 9.81
NX_F = int(FD_LEN / MESH)
NY = int(FD_THK / MESH)
NZ_F = int(FD_DEP / MESH)
NZ_D = int(DAM_H / MESH)
NX_D = int(DAM_BASE_W / MESH)
X0 = -FD_LEN / 2.0
A_UP = int((UP_X - X0) / MESH)

# ========== 2. 材料 ==========
MatDB.load()
setting = Setting()
mat_dam = MatDB.assemble("C30", iType=MaterialType.Concrete,
                         iMark=ConcreteType.C30, setting=setting)
mat_rock = Material(name="FoundationRock", iType=MaterialType.Custom,
                    iModel=MaterialModel.Elastic,
                    E0=2.0e10, poisson=0.25, density=2600.0)

# ========== 3. 截面 ==========
sec_dam = Section("DamSolidC30", SectionType.Solid, SolidSect(mid=mat_dam.id))
sec_rock = Section("RockSolid", SectionType.Solid, SolidSect(mid=mat_rock.id))

# ========== 4. 节点 ==========
fnd = []
for a in range(NX_F + 1):
    plane = []
    for b in range(NY + 1):
        line = [Node(X0 + a * MESH, b * MESH, -FD_DEP + c * MESH)
                for c in range(NZ_F + 1)]
        plane.append(line)
    fnd.append(plane)

def dam_x(i, k):
    z = k * MESH
    x_ds = (UP_X + DAM_CREST_W) + (DAM_H - z) * (DAM_BASE_W - DAM_CREST_W) / DAM_H
    return UP_X + (x_ds - UP_X) * i / NX_D

dnode = []
for k in range(NZ_D + 1):
    layer = []
    for i in range(NX_D + 1):
        if k == 0:
            line = [fnd[A_UP + i][b][NZ_F] for b in range(NY + 1)]
        else:
            line = [Node(dam_x(i, k), b * MESH, k * MESH) for b in range(NY + 1)]
        layer.append(line)
    dnode.append(layer)

# ========== 5. 单元 ==========
felem = []
for a in range(NX_F):
    colm = []
    for b in range(NY):
        row = []
        for c in range(NZ_F):
            n1 = fnd[a][b][c];     n2 = fnd[a + 1][b][c]
            n3 = fnd[a + 1][b + 1][c]; n4 = fnd[a][b + 1][c]
            n5 = fnd[a][b][c + 1];     n6 = fnd[a + 1][b][c + 1]
            n7 = fnd[a + 1][b + 1][c + 1]; n8 = fnd[a][b + 1][c + 1]
            row.append(Element(nids=[n1.id, n2.id, n3.id, n4.id,
                                     n5.id, n6.id, n7.id, n8.id],
                               type=ElementType.Solid, sid=sec_rock.id))
        colm.append(row)
    felem.append(colm)

delem = []
for k in range(NZ_D):
    layer = []
    for i in range(NX_D):
        row = []
        for b in range(NY):
            n1 = dnode[k][i][b];     n2 = dnode[k][i + 1][b]
            n3 = dnode[k][i + 1][b + 1]; n4 = dnode[k][i][b + 1]
            n5 = dnode[k + 1][i][b];     n6 = dnode[k + 1][i + 1][b]
            n7 = dnode[k + 1][i + 1][b + 1]; n8 = dnode[k + 1][i][b + 1]
            row.append(Element(nids=[n1.id, n2.id, n3.id, n4.id,
                                     n5.id, n6.id, n7.id, n8.id],
                               type=ElementType.Solid, sid=sec_dam.id))
        layer.append(row)
    delem.append(layer)

all_eids = [e.id for e in [el for colm in felem for row in colm for el in row]] + \
           [e.id for e in [el for layer in delem for row in layer for el in row]]

# ========== 6. 集合 ==========
Elset("AllSolids", all_eids)
base_nids = [fnd[a][b][0].id for a in range(NX_F + 1) for b in range(NY + 1)]
Nset("BaseNodes", base_nids)

# ========== 7. 支座 ==========
Fixed(gnids=base_nids, dof=[Dof.All])

wp_esides = [(delem[k][0][b].id, 6) for k in range(NZ_D) for b in range(NY)]
wp_esides += [(felem[a][b][NZ_F - 1].id, 2) for a in range(A_UP) for b in range(NY)]

# ========== 8. 荷载工况 (三工况独立) ==========
lc_dl = LoadCase("DL")
lc_dl.add(Emload(geids=all_eids, value=G_GRAV, dir=[0, 0, -1]))

lc_wp = LoadCase("WP")
lc_wp.add(Wpload(esides=wp_esides, type=WaterPressureType.SolidSurface,
                 value=RHO_W * G_GRAV * WATER_H, h0=WATER_H, h=0.0))

A_PEAK = 0.7
S_TIME = 10.0
STEP_LEN = 0.02
DT_WAVE = 0.02
F_MAIN = 2.0
npt = int(S_TIME / DT_WAVE) + 1
time_hist = []
for i in range(npt):
    t = round(i * DT_WAVE, 6)
    if t < 1.0:
        env = t
    elif t <= 8.0:
        env = 1.0
    else:
        env = max(0.0, (S_TIME - t) / 2.0)
    time_hist.append([t, math.sin(2.0 * math.pi * F_MAIN * t) * env])

lc_eq = LoadCase("EQ")
lc_eq.add(Wload(gnids=base_nids, wType=WaveType.Acceleration,
                iType=WaveActionType.Boundary,
                value=A_PEAK, timeHist=time_hist, dir=[1, 0, 0]))

# ========== 9. 三个分析 (索引 0/1/2) ==========
analy_static = Analy("StaticAnalysis")
analy_static.add(Step("Step_DL").add(LoadCaseCombine(lc_dl.id, 1.0)))
analy_static.add(Step("Step_WP").add(LoadCaseCombine(lc_wp.id, 1.0)))
step_all = Step("Step_ALL")
step_all.add(LoadCaseCombine(lc_dl.id, 1.0)).add(LoadCaseCombine(lc_wp.id, 1.0))
analy_static.add(step_all)

analy_spec = Analy("SpectrumX", setting=AnalySetting(
    anaType=AnaType.SPECTRUM, iType=SpectrumAnaMethod.Code,
    intensity=SeismicIntensity.Eight, seismicLevel=SeismicLevel.Frequent,
    siteType=SiteClass.Class2, iGroup=DesignEarthquakeGroup.Group1,
    iCombine=ModalCombine.CQC, nModalSpectrum=20,
    iDampType=AnaDampType.RatioToMass, dampRatio=0.05,
    direction=[1.0, 0, 0]))
analy_spec.add(Step("Step_SP_DL").add(LoadCaseCombine(lc_dl.id, 1.0)))

st_eq = Step("Step_EQ", nSubstep=int(S_TIME / STEP_LEN), sTime=S_TIME)
st_eq.add(LoadCaseCombine(lc_eq.id, 1.0))
analy_th = Analy("TimeHist", setting=AnalySetting(
    anaType=AnaType.IMPLICIT, iType=ImpAnaMethod.Direct,
    sTime=S_TIME, stepLen=STEP_LEN,
    iDampType=AnaDampType.RatioToMass, dampRatio=0.05))
analy_th.add(st_eq)

# ========== 10. 分析任务 (多任务: 一分析一Job) ==========
job_static = Job("StaticJob", main=0)
job_spec = Job("SpectrumJob", main=1, uid="g1d2s3")
job_th = Job("TimeHistJob", main=2, uid="t4h5w6")
jobs = [job_static, job_spec, job_th]

# ========== 11. 收口 (按 CUR_TASK 指定当前任务; 同一脚本跑三次即算完三种分析) ==========
JobManager(main=jobs[CUR_TASK].main, pre=jobs[CUR_TASK].pre, uid=jobs[CUR_TASK].uid, jobs=jobs)
FemModel.toViewer()
FemModel.submitAndSolve()
