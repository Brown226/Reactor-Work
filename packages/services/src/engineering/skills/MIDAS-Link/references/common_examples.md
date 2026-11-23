# MIDAS GEN NX 常用示例

以下示例使用 kN–m–℃，后续片段接续第 1 节。连接排障见 connection.md；坐标、单位与符号见 SKILL.md。

## 1. 最小完整脚本：连接 → 建模 → 分析 → 取结果

独立 2 m 轴向杆，钢管 P114×5，E=206 GPa，端部 +X 10 kN，无自重。理论值 `u=PL/(EA)`、轴力 +10 kN、支座反力 −10 kN。用于验证 API 和单位，不是规范设计范例。

在 `python_executor` 执行。前提是已为任务准备独立空白工程；脚本检查模型统计和关键表，非空即停止，不替用户保存、清空正在工作的模型。输出目录自动唯一化，软件保留打开。沿用已有工程时跳过 NEW/设单位及固定 ID，改为读取现有单位和未占用 ID。

```python
from pathlib import Path
from uuid import uuid4
import math
from PKPMAgent.software_link_kit.midas import connect_midas

midas = connect_midas()
if midas.info['mode'] != 'local':
    raise RuntimeError('本示例的文件检查适用于本机 GEN NX；远程须在软件所在主机检查路径')

# —— 当前模型检查：不能仅凭没有节点就认定工程为空 ——
status = midas.request('GET', '/ope/PROJECTSTATUS')['PROJECTSTATUS']
if any(str(row[1]) != '0' for row in status['DATA']
       if row[0] not in ('StructureType', '结构类型')):
    raise RuntimeError('当前工程非空，请使用独立空白工程')
for table in ('PJCF', 'NODE', 'ELEM', 'MATL', 'SECT', 'STLD', 'CONS', 'CNLD', 'BODF', 'LCOM-GEN'):
    r = midas.request('GET', '/db/'+table)
    if r not in ({'message': ''}, {table: {}}):
        raise RuntimeError(f'{table} 非空或响应无法识别')

# —— 新建后再设单位；单位不能只读连接时的快照 ——
midas.request('POST', '/doc/NEW', {'Argument': {}})
midas.request('PUT', '/db/UNIT', {'Assign': {'1': {
    'FORCE': 'KN', 'DIST': 'M', 'HEAT': 'KJ', 'TEMPER': 'C'}}})
unit = midas.request('GET', '/db/UNIT')['UNIT']['1']
assert (unit['FORCE'], unit['DIST'], unit['TEMPER']) == ('KN', 'M', 'C')
midas.request('PUT', '/db/STYP', {'Assign': {'1': {'STYP': 0}}})  # 0 = 三维结构
assert midas.request('GET', '/db/STYP')['STYP']['1']['STYP'] == 0

# —— 材料、截面、节点、单元、约束、工况、荷载，按依赖顺序创建 ——
params = {'diameter_m': .114, 'wall_m': .005, 'span_m': 2.0,
          'elastic_kn_m2': 2.06e8, 'axial_load_kn': 10.0}
params['area_m2'] = math.pi*params['wall_m']*(params['diameter_m']-params['wall_m'])
# 参数集中保存，不用 A 同时表示网格间距和截面面积；理论面积不从待验 STIFF 反推。
model = {
    'MATL': {'1': {'TYPE': 'STEEL', 'NAME': 'API_E206GPa', 'bMASS_DENS': False,
        'PARAM': [{'P_TYPE': 2, 'ELAST': params['elastic_kn_m2'], 'POISN': .3, 'THERMAL': 1.2e-5,
                   'DEN': 76.98, 'MASS': 0}]}},  # PARAM 是数组；DEN 是 kN/m³；此模式不使用 MASS
    'SECT': {'1': {'SECTTYPE': 'VALUE', 'SECT_NAME': 'API_P114x5', 'CALC_OPT': True,
        'SECT_BEFORE': {'OFFSET_PT': 'CC', 'OFFSET_CENTER': 0, 'USER_OFFSET_REF': 0,
            'HORZ_OFFSET_OPT': 0, 'USERDEF_OFFSET_YI': 0, 'VERT_OFFSET_OPT': 0,
            'USERDEF_OFFSET_ZI': 0, 'USE_SHEAR_DEFORM': True, 'USE_WARPING_EFFECT': False,
            'SHAPE': 'P', 'SECT_I': {'vSIZE': [params['diameter_m'], params['wall_m'], 0, 0, 0, 0, 0, 0]}}}},
    # 自动计算时不传旧 STIFF/DESIGN。后端会 GET 核验 AREA、RYY、RZZ。
    'NODE': {'1': {'X': 0, 'Y': 0, 'Z': 0}, '2': {'X': params['span_m'], 'Y': 0, 'Z': 0}},
    'ELEM': {'1': {'TYPE': 'TRUSS', 'MATL': 1, 'SECT': 1, 'NODE': [1, 2], 'ANGLE': 0}},
    'STLD': {'1': {'NAME': 'TEST', 'TYPE': 'D', 'DESC': 'Axial API check'}},
    # 创建 D 工况本身不施加自重；自重另用 BODF。本用例不施加。
    'CNLD': {'2': {'ITEMS': [{'ID': 1, 'LCNAME': 'TEST', 'GROUP_NAME': '',
                             'FX': params['axial_load_kn'], 'FY': 0, 'FZ': 0, 'MX': 0, 'MY': 0, 'MZ': 0}]}},
}

def check_input(actual, expected):
    # 只核对输入字段，允许软件补默认值；ELEM.NODE 会补齐到八项。
    if isinstance(expected, dict):
        for k, v in expected.items():
            if k != 'CALC_OPT':  # Create Only，GET 不返回此开关
                check_input(actual[k], v)
    elif isinstance(expected, list):
        assert len(actual) >= len(expected)
        for a, b in zip(actual, expected):
            check_input(a, b)
        assert all(x == 0 for x in actual[len(expected):])
    elif isinstance(expected, (int, float)) and not isinstance(expected, bool):
        assert math.isclose(actual, expected, rel_tol=1e-6, abs_tol=1e-12)
    else:
        assert actual == expected

for table, assign in model.items():
    midas.request('POST', '/db/'+table, {'Assign': assign})
    check_input(midas.request('GET', '/db/'+table)[table], assign)

# 键是节点号；七位依次为 DX,DY,DZ,RX,RY,RZ,RW，1 约束、0 释放；RW 为 CIVIL 专属。
# helper 为每个节点生成独立 CONS 记录，ITEMS.ID 各从 1 开始，并 GET 逐一核对。
# 只用于已存在且尚无支承的节点；不覆盖既有支承。
midas.create_supports({'1': '1111110', '2': '0111110'})
actual_nodes = midas.request('GET', '/db/NODE')['NODE']
assert set(actual_nodes) == {'1', '2'}
coordinates = [tuple(actual_nodes[node][axis] for axis in ('X','Y','Z')) for node in ('1','2')]
assert math.isclose(math.dist(*coordinates), params['span_m'], rel_tol=1e-9)

# —— 保存原生 .mgbx 后分析。文件路径由 GEN NX 所在主机解析 ——
folder = Path.home()/'Documents'/'PKPMAgent'/('midas_example_'+uuid4().hex[:8])
folder.mkdir(parents=True, exist_ok=False)
path = folder/'axial_rod.mgbx'
midas.request('POST', '/doc/SAVEAS', {'Argument': str(path)})
assert path.is_file() and path.stat().st_size > 0
reply = midas.request('POST', '/doc/ANAL', {})  # 普通分析不是统一的 Assign 包装
print('analysis response:', reply)  # command complete 仍需下面的结果检查

# —— 结果：TABLE_TYPE 选表种类，TABLE_NAME 选响应键，工况查询加 (ST) ——
values = {}
for name, kind, columns, keys, column, expected in (
    ('U', 'DISPLACEMENTG', ['Node', 'Load', 'DX'], [2], 'DX',
     params['axial_load_kn']*params['span_m']/(params['elastic_kn_m2']*params['area_m2'])),
    ('N', 'TRUSSFORCE', ['Elem', 'Load', 'Force-I', 'Force-J'], [1], 'Force-I', params['axial_load_kn']),
    ('R', 'REACTIONG', ['Node', 'Load', 'FX'], [1], 'FX', -params['axial_load_kn']),
):
    table = midas.get_table({
        'TABLE_NAME': name, 'TABLE_TYPE': kind,
        'UNIT': {'FORCE': 'kN', 'DIST': 'm'},
        'STYLES': {'FORMAT': 'Scientific', 'PLACE': 10},
        'COMPONENTS': columns, 'NODE_ELEMS': {'KEYS': keys},
        'LOAD_CASE_NAMES': ['TEST(ST)'],
    }, expected_columns=columns, expected_loads=['TEST'])  # 查询 TEST(ST)，行标签 TEST
    # get_table 按 HEAD 对应 DATA，保留 Index，检查重复列、行宽、单位、空表。
    # 不默认 EXPORT_PATH；需要落盘时再给唯一文件路径，避免每次查询覆盖同一文件。
    rows = table['rows']
    assert len(rows) == 1 and rows[0]['Load'] == 'TEST'
    assert int(rows[0]['Elem' if name == 'N' else 'Node']) == keys[0]
    value = float(rows[0][column])  # 字符串不自动转数值；****/缺值不能当作 0
    assert math.isfinite(value) and math.isclose(value, expected, rel_tol=1e-5, abs_tol=1e-10)
    if name == 'N':  # 本例没有杆间荷载，两端轴力才相等；有 BODF 时不能照搬。
        assert math.isclose(float(rows[0]['Force-J']), expected, rel_tol=1e-5)
    values[name] = value
print({'model': str(path), 'DX_m': values['U'], 'N_kN': values['N'], 'RX_kN': values['R']})
# midas.close() 仅释放 HTTP 客户端；不退出软件、不关闭工程。
```

**批量支承：** 每个支承节点占一个外层键，不能把多个节点塞入同一条 ITEMS。`ITEMS.ID` 是节点内约束项序号，各节点可分别从 1 开始。同节点同边界组的项可能合并；修改已有支承应按节点、边界组和实际约束核对，不能仅比较返回项数。原始 JSON 可查 `detail /db/CONS --section examples --block local_multiple_nodes`。

## 2. 截面：修改尺寸时保证刚度同步

`VALUE.CALC_OPT` 是 **Create Only**。PUT 改 `vSIZE` 不代表 `STIFF` 已更新；创建时显式 `STIFF` 也会优先于自动计算。圆管 `vSIZE=[D,t,...]`，矩形 `SB=[H,B,...]`；`RYY/RZZ` 是二次矩，单位 L⁴，不是回转半径。矩形 `Iyy=B·H³/12`、`Izz=H·B³/12`。

VALUE 的实际刚度在 **`SECT[id]['SECT_BEFORE']['SECT_I']['STIFF']`**。后端用独立几何值或 `expected_stiffness` 与该位置的 GET 实际值比较；缺字段时报 `section_verification_unavailable`，不能填预期值冒充读回。

截面特性另有 `detail "POST/Pre-Process Table" "Section Table"`，`TABLE_TYPE='SECTIONALL'` 返回 `ID/Area/Iyy/Izz` 等列。按实际 HEAD 取值并核对 FORCE/DIST；该表的默认显示精度可能把小惯性矩输出为 `0.0000`，不能替代精确 STIFF 核验，也不能假定它支持结果表的全部格式参数。`Section Manager - Stiffness`（`/db/SECF`）是刚度调整系数接口，不是截面实际刚度查询。

推荐先创建新 ID，核验成功后改目标单元引用。下面接续 §1，把单元 1 改为 P168×6；保留旧截面，便于核对。读取截面时不要把旧 `STIFF`、`DESIGN`、周长等派生值整个复制到新请求。

```python
from copy import deepcopy
sections = midas.request('GET', '/db/SECT')['SECT']
new_id = str(max(map(int, sections))+1)
fresh = deepcopy(model['SECT']['1'])  # §1 的纯输入定义，不是 GET 的完整输出
fresh['SECT_NAME'] = 'API_P168x6'
fresh['SECT_BEFORE']['SECT_I']['vSIZE'] = [.168, .006, 0, 0, 0, 0, 0, 0]
midas.request('POST', '/db/SECT', {'Assign': {new_id: fresh}})
# 后端已按几何核验 AREA、RYY、RZZ，失败时抛错并标记 write_completed=True。
elements = midas.request('GET', '/db/ELEM')['ELEM']
updated = deepcopy(elements['1'])
updated['SECT'] = int(new_id)
midas.request('PUT', '/db/ELEM', {'Assign': {'1': updated}})
assert midas.request('GET', '/db/ELEM')['ELEM']['1']['SECT'] == int(new_id)
# 保存并重新分析后才能使用新结果；不要继续读取上一次分析当作更新结果。
```

后端自动几何核验限于纯自动创建的 P/SB/SR。其他 VALUE 形状或手工指定刚度，在 `midas.request(...)` 中传 `expected_stiffness={截面ID: {'AREA': 独立面积, 'RYY': 独立Iyy, 'RZZ': 独立Izz}}`，它是客户端校验参数，不放进 REST 请求体。改变尺寸的手工 PUT 还须显式提供完整 STIFF，同步适用的 DESIGN、周长等派生属性。三项核验不代表剪切、扭转、翘曲和设计参数全部正确。

后端不自动 DELETE+POST，也不自动回滚。被引用截面直接删除可能影响单元/设计数据；只有核实全部引用和恢复方案后才采用重建原 ID。

## 3. 多工况、节点荷载、自重与通用组合

以下接续 §1，为同一节点增加第二个工况。实际工程先读取 `/db/STLD` 的名称与 ID，不能照搬固定编号。外层 CNLD 键是节点号，`ITEMS.ID` 是**该节点内**的荷载项序号；换工况不重置编号，不同节点可各自从 1 开始。

```python
cases = midas.request('GET', '/db/STLD')['STLD']
if any(v['NAME'] == 'LIVE' for v in cases.values()):
    raise RuntimeError('LIVE 已存在，先核对，不能重复跑本段')
case_id = str(max(map(int, cases))+1)
midas.request('POST', '/db/STLD', {'Assign': {case_id: {'NAME': 'LIVE', 'TYPE': 'L'}}})
assert midas.request('GET', '/db/STLD')['STLD'][case_id]['NAME'] == 'LIVE'

old = midas.request('GET', '/db/CNLD')['CNLD']['2']['ITEMS']
item_id = max(item['ID'] for item in old)+1  # 这里为 2，不能再次使用 1
added = {'ID': item_id, 'LCNAME': 'LIVE', 'GROUP_NAME': '', 'FX': 5.0}
midas.request('POST', '/db/CNLD', {'Assign': {'2': {'ITEMS': [added]}}})  # 只传新增项
actual = midas.request('GET', '/db/CNLD')['CNLD']['2']['ITEMS']
by_id = {item['ID']: item for item in actual}
assert all(by_id[item['ID']] == item for item in old)  # 原工况仍在
assert by_id[item_id]['LCNAME'] == 'LIVE' and by_id[item_id]['FX'] == 5.0

# 通用组合直接用 /db/LCOM-GEN；/ope/LCOM-* 是按规范自动生成，另有用途。
r = midas.request('GET', '/db/LCOM-GEN')
combos = {} if r == {'message': ''} else r['LCOM-GEN']
comb_id = str(max([int(k) for k in combos] or [0])+1)
if any(v['NAME'] == 'SERVICE' for v in combos.values()):
    raise RuntimeError('SERVICE 已存在')
combo = {'NAME': 'SERVICE', 'ACTIVE': 'ACTIVE', 'iTYPE': 0, 'DESC': 'API demo only',
         'vCOMB': [{'ANAL': 'ST', 'LCNAME': 'TEST', 'FACTOR': 1.0},
                   {'ANAL': 'ST', 'LCNAME': 'LIVE', 'FACTOR': 1.0}]}
midas.request('POST', '/db/LCOM-GEN', {'Assign': {comb_id: combo}})
check_input(midas.request('GET', '/db/LCOM-GEN')['LCOM-GEN'][comb_id], combo)
# 更新荷载后 SAVE、ANAL，再在 get_table 的 LOAD_CASE_NAMES 中用 SERVICE(CB)。
# vCOMB 定义里 LCNAME 不带 (ST)，结果查询里才加 (ST)/(CB)。
# iTYPE: 0=代数相加，1=包络，2=ABS，3=SRSS；此处 1.0 系数只是 API 演示。
```

新节点一次写双工况可以提交 `ITEMS=[{'ID':1,'LCNAME':'DL','FZ':-9}, {'ID':2,'LCNAME':'LL','FZ':-4.5}]`；前提是节点和 DL/LL 已存在且这两个 ID 未被占用。数据库可直接查 `detail /db/CNLD --section examples --block local_dual_case`。

自重用 `/db/BODF`：`{'Assign': {'未占用的整数ID': {'LCNAME':'DL','GROUP_NAME':'','FV':[0,0,-1]}}}`。FV 是方向系数，不是总重；对应材料 DEN、截面和几何共同决定重量。先读现有 BODF，避免重复计入同工况自重；写后 GET。按当前杆件实际几何和截面计算 `W=Σ(A·L·DEN)`，不能硬编码杆件数量或总长度。非均匀、偏心、板/实体及特殊质量设置须使用对应荷载规则。

多工况查询与分组接续上面的 TEST、LIVE、SERVICE，先保存并重新分析。查询选择符带 `(ST)/(CB)`，该普通静力表返回的 Load 标签不带这些后缀；用实际标签分组，并断言对象与组都完整：

```python
midas.request('POST', '/doc/SAVE', {'Argument': {}})
midas.request('POST', '/doc/ANAL', {})
reaction = midas.get_table({'TABLE_NAME': 'multi_case_reactions', 'TABLE_TYPE': 'REACTIONG',
    'COMPONENTS': ['Node', 'Load', 'FX'], 'NODE_ELEMS': {'KEYS': [1]},
    'LOAD_CASE_NAMES': ['TEST(ST)', 'LIVE(ST)', 'SERVICE(CB)'],
    'UNIT': {'FORCE': 'kN', 'DIST': 'm'}, 'STYLES': {'FORMAT': 'Scientific', 'PLACE': 10}},
    expected_columns=['Node', 'Load', 'FX'], expected_loads=['TEST', 'LIVE', 'SERVICE'])
expected_rx = {'TEST': -params['axial_load_kn'], 'LIVE': -5.0,
               'SERVICE': -params['axial_load_kn']-5.0}
assert set(reaction['load_names']) == set(expected_rx)
by_load = {label: [] for label in reaction['load_names']}
for row in reaction['rows']:
    by_load[row['Load']].append(row)
for label, expected in expected_rx.items():
    assert len(by_load[label]) == 1 and int(by_load[label][0]['Node']) == 1
    assert math.isclose(float(by_load[label][0]['FX']), expected, rel_tol=1e-5)
```

## 4. 请求体速查

| 调用 | 请求体 | 易错点 |
|---|---|---|
| GET `/db/...` | 无 | 返回表名键；空表可能是 `{"message":""}` |
| POST/PUT `/db/...` | `{"Assign":{"ID":对象}}` | UNIT/STYP 等只允许 GET/PUT；不能统一推定 CRUD |
| DELETE `/db/NODE/123` 等 | 无 | 先查具体表的删除语义和引用，不能自动级联清理 |
| POST `/doc/NEW`、`SAVE`、`CLOSE` | `{"Argument":{}}` | 总手册允许空 Argument 简写 `{}`；NEW/CLOSE 会影响当前工程 |
| POST `/doc/OPEN`、`SAVEAS` | `{"Argument":"绝对路径"}` | GEN NX 使用 `.mgbx`，先创建目录 |
| POST `/doc/ANAL` 普通分析 | `{}` | Pushover 是 `{"Argument":{"TYPE":"Pushover"}}`，另查契约 |
| POST `/post/TABLE` | `{"Argument":{...}}` | `get_table()` 只传内部对象，不再套 Argument |

结果表若支持 `STYLES`，小位移建议 Scientific 格式，避免 Fixed 位数太少截成 0。

### 删除指定记录

以下均无请求体，末段是**外层对象 ID**。CNLD/PRES 会删除该对象的全部荷载项，不能把 ITEMS.ID 放到该位置当作单工况删除：

| 目标 | 调用 | 删除范围 |
|---|---|---|
| 节点荷载 | `midas.request('DELETE', f'/db/CNLD/{node_id}')` | 该节点整条 CNLD，包含其所有工况；节点本身保留 |
| 单元压力 | `midas.request('DELETE', f'/db/PRES/{element_id}')` | 该单元整条 PRES，包含其所有工况；单元本身保留 |
| 单元 | `midas.request('DELETE', f'/db/ELEM/{element_id}')` | 单元本身；先处理其荷载、连接和组等引用 |
| 节点 | `midas.request('DELETE', f'/db/NODE/{node_id}')` | 节点本身；先处理连接单元、荷载、支承和组等引用 |

按需选择目标，删后 GET 检查目标键消失及其余记录保留。不要省略 ID 调用整表 DELETE，也不要依赖自动级联清理。只删某个 ITEMS 项时，另查项级删除/更新契约，不用整条删除冒充。下面示意删除明确选定的压力记录：

```python
target_element_id = 801  # 替换为任务确认要删除的压力所属单元，不是 ITEMS.ID
before = midas.request('GET', '/db/PRES')['PRES']
assert str(target_element_id) in before
midas.request('DELETE', f'/db/PRES/{target_element_id}')
reply = midas.request('GET', '/db/PRES')
after = {} if reply == {'message': ''} else reply['PRES']
assert set(after) == set(before)-{str(target_element_id)}
assert all(after[key] == row for key, row in before.items() if key != str(target_element_id))
```

## 5. 结果检查与异常排查

常规确认结果属于当前模型与分析、目标对象/工况齐全、数值有效，并检查位移量级。发现缺失或异常时，先核查单位、荷载、边界和本次桌面分析消息；公开 REST 目录尚无通用求解日志/告警读取入口。

结果异常排查或任务明确要求时，再选择整体平衡、独立理论解等复核方法。若做静力平衡，须在相同坐标与单位下计入全部外荷载/支反力、自重及分布荷载；力矩含 `r×F`，内部传力不重复计入，误差考虑输出精度。包络极值可能来自不同受力状态，动力结果还涉及惯性/阻尼，不能直接套用普通静力平衡。

设计验算另需项目规范、材料强度、有效长度、稳定参数等依据，不能直接套用示例组合系数或挠度限值。

## 6. 面荷载与导荷面（蒙皮）

蒙皮导荷用独立零密度材料、面内/面外分离板厚及 PLATE+PRES；楼面向梁墙分配用 FBLD/FBLA，板/实体局部区域加载用 PNLD/PNLA。

读 `use_skill('MIDAS-Link', file='references/surface_loads.md')` 获取蒙皮建模示例、方向与投影、PSLT/PSSF 的关键字段；按实际屋面节点使用，独立于本文件的轴向杆例子。
