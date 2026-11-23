# 面荷载与蒙皮导荷

蒙皮（虚面、导荷面）用低刚度辅助板承接面压力，再将荷载传给网架或框架。常规流程为：独立零密度材料 → 面内/面外分离板厚 → PLATE → PRES → 保存分析。

## 1. 常用蒙皮示例

以下使用 kN–m；屋面节点 1、2、3、4 已存在并按板边界顺序排列，DL 已定义。材料和板厚 9001、板单元 801 为本次新增 ID，须先确认未占用。复用 common_examples.md §1 的 `midas` 与 `check_input`。

示例采用 `T_IN=1e-6 m`、`T_OUT=5e-4 m`：以微小面内厚度减弱膜刚度，保留微小面外厚度。它们是导荷用数值厚度，不是屋面构造板厚；换长度单位时须同步换算。辅助板不用于材料、截面或板承载力设计。

```python
skin_params = {'material_id': 9001, 'thickness_id': 9001, 'element_id': 801,
               'node_ids': [1, 2, 3, 4], 'load_case': 'DL',
               'in_plane_m': 1e-6, 'out_plane_m': 5e-4, 'pressure_kn_m2': -1.2}

def read_skin_table(name):
    reply = midas.request('GET', '/db/'+name)
    return {} if reply == {'message': ''} else reply[name]

unit = read_skin_table('UNIT')['1']
assert (unit['FORCE'], unit['DIST']) == ('KN', 'M')
assert set(map(str, skin_params['node_ids'])) <= set(read_skin_table('NODE'))
assert skin_params['load_case'] in {case['NAME'] for case in read_skin_table('STLD').values()}
for table, key in (('MATL', 'material_id'), ('THIK', 'thickness_id'), ('ELEM', 'element_id')):
    assert str(skin_params[key]) not in read_skin_table(table), f'{table} ID 已占用'

skin_model = {
    'MATL': {str(skin_params['material_id']): {
        'TYPE': 'STEEL', 'NAME': 'LOAD_SKIN', 'bMASS_DENS': False,
        'PARAM': [{'P_TYPE': 2, 'ELAST': 2.06e8, 'POISN': .3,
                   'THERMAL': 0, 'DEN': 0, 'MASS': 0}]}},
    'THIK': {str(skin_params['thickness_id']): {
        'NAME': 'LOAD_SKIN_T', 'TYPE': 'VALUE', 'bINOUT': True,
        'T_IN': skin_params['in_plane_m'], 'T_OUT': skin_params['out_plane_m']}},
    # PLATE 的 SECT 引用板厚 THIK；STYPE=2 为薄板。
    'ELEM': {str(skin_params['element_id']): {
        'TYPE': 'PLATE', 'STYPE': 2, 'MATL': skin_params['material_id'],
        'SECT': skin_params['thickness_id'], 'NODE': skin_params['node_ids'], 'ANGLE': 0}},
    'PRES': {str(skin_params['element_id']): {'ITEMS': [{
        'ID': 1, 'LCNAME': skin_params['load_case'], 'GROUP_NAME': '', 'CMD': 'PRES',
        'ELEM_TYPE': 'PLATE', 'FACE_EDGE_TYPE': 'FACE', 'DIRECTION': 'GZ',
        'OPT_PROJECTION': False, 'FORCES': [skin_params['pressure_kn_m2'], 0, 0, 0, 0]}]}},
}
for table, assignment in skin_model.items():
    midas.request('POST', '/db/'+table, {'Assign': assignment})
    check_input(read_skin_table(table), assignment)
# 保存、分析后按工况读取所需结果，确认结果完整、数值有效及位移量级合理。
```

多片屋面复用同一蒙皮材料与板厚，每片板用独立 ELEM/PRES 外层键。相邻片共用真实结构节点，不重复建重合节点；不重复覆盖同一导荷区域。多个工况在同一板的 PRES.ITEMS 内分配不同 ID，不能每个工况都从 1 开始。

- **自重和质量：** 使用独立材料，明确 DEN=0、MASS=0 及密度模式，防止 BODF 把蒙皮重量计入；不要修改真实构件材料。动力任务另查荷载转质量设置，物理屋面质量按任务单独计入。
- **厚度：** `bINOUT=True` 才采用分离的 T_IN/T_OUT。板自重通常按面内厚度计算，T_IN=0 时可能改用面外厚度，不能靠零面内厚度排除自重。
- **模型检查：** 核对板节点顺序、连通性、板厚引用和加载区域。辅助板保留数值刚度；分析出现奇异或位移异常时按相应节点/自由度排查，不靠它稳定原有机构。

## 2. 压力方向、面积与相关字段

| 项目 | 用法 |
|---|---|
| 方向 | PLATE+FACE 不支持 NORMAL；显式用 LX/LY/LZ/GX/GY/GZ/VECTOR。面法向用 LZ；全局向下用 GZ 配负压力。VECTOR 还须提供 VECTORS |
| 符号 | FORCES 正负沿所选方向；局部 z 由板的节点顺序确定，反向节点顺序可能反转法向 |
| 均布压力 | `FORCES=[q,0,0,0,0]`，量纲 F/L²；线性变化压力用 `[0,P1,P2,P3,P4]`，按实际节点位置赋值。EDGE 荷载另用 EDGE_LOADS，不能混用 |
| 面积口径 | `OPT_PROJECTION=False` 按实际面面积；全局方向下为 True 时按垂直于该方向的投影面积。斜屋面先确认荷载指标按斜面还是水平投影给定 |
| PRES 绑定 | 外层键是单元号，ITEMS.ID 是该单元内的荷载项序号；直接给 LCNAME/FORCES 不要求先建 PSLT |
| PSLT 字段 | PSLT 是可复用压力类型，工况字段为 `PRESSURE_LOAD_ITEMS[*].LOADCASENAME`；原参数表的 CMD 有误，不要与 PRES 的 `CMD='PRES'` 混用 |
| PSSF 绑定 | 外层键直接指定板单元号，ITEMS.ID 为单元内序号。GROUP_NAME 是边界组标签，空串为默认组；不是选板的结构组。PSSF 调整刚度，不取消自重/质量 |

需要统计荷载总量时，按各片面积、方向和工况计算；实际面积的均布压力为 `q·A·d`，按投影面积时替换有效面积，法向压力逐片按各自法向求和。不要在同一工况叠加表示同一份屋面荷载的 PRES 与 CNLD/FBLA。

## 3. 其他面荷载入口

| 任务 | 官方术语与接口 | 适用范围 |
|---|---|---|
| 楼面向梁墙分配荷载 | Define Floor Load Type `/db/FBLD` → Assign Floor Loads `/db/FBLA` | 按一向/两向/多边形规则分配到封闭共面区域内梁墙，不默认适用于纯 TRUSS 网架 |
| 板/实体上的局部设备等加载区域 | Define Plane Load Type `/db/PNLD` → Assign Plane Loads `/db/PNLA` | 区域可独立于网格，但仍依赖已有 PLATE/SOLID，不是创建导荷蒙皮 |
| 任务指定的节点等效荷载 | Nodal Loads `/db/CNLD` | 分担面积/等效力按任务规则计算，写法见 common_examples.md §3 |

检索用英文接口名或 REST 路径，不用 Skin/Virtual Surface 猜测接口名。压力与系数详情可直接 `detail /db/PRES`、`detail /db/PSSF`、`detail /db/PSLT`；板厚用 `detail "DB/Properties" "Thickness - Value"`。
