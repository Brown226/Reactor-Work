# PKPM Agent → Reactor 移植设计方案

> 依据：22 份技能正文 + 1,379 条签名 + 全部明文脚本 + 两张实机截图
> 目标：在 Reactor 中重建等价的工程智能体能力

---

## 零、先明确一个根本认知

**这不是"内嵌面板 + 屏幕镜像"，是"API 直连 + 软件自己执行"。**

```
用户说话
  → Agent 算坐标、定参数
  → 通过 MCP 把指令发给 PKPM 进程
  → PKPM 用自己的图形内核建模、渲染
  → Agent 读回数值验证
```

Agent **全程"看不见"画面**，它看到的是节点坐标、构件 ID、截面参数。
所以：**不做屏幕采集，只做 API 封装。**

---

## 一、总体架构

```
┌─────────────────────────────────────────────────────┐
│ Reactor (Electron)                                    │
│  ├─ Agent 窗口（置顶，可缩窄成竖条）                    │
│  └─ packages/web UI                                  │
└──────────────────┬──────────────────────────────────┘
                   │ IPC
┌──────────────────▼──────────────────────────────────┐
│ packages/services/src/mcp-link/   ← 【新建】          │
│   BaseMCPLink (抽象)                                  │
│   ├─ BimBaseLink   (PKPM/PlantS)                      │
│   ├─ Sap2000Link                                      │
│   ├─ RhinoLink                                        │
│   ├─ AutoCadLink                                      │
│   └─ OfficeLink                                       │
│   registry.ts  (注册表，14 个函数)                     │
└──────────────────┬──────────────────────────────────┘
                   │ child_process
┌──────────────────▼──────────────────────────────────┐
│ Python 执行器（复用，不改 DB 层）                      │
│   execworker: 子进程池，会话常驻                        │
└──────────────────┬──────────────────────────────────┘
                   │ MCP (HTTP + JSON-RPC) / COM
┌──────────────────▼──────────────────────────────────┐
│ PKPM / BIMBase / SAP2000 …（用户已开着的进程）          │
└─────────────────────────────────────────────────────┘
```

**关键决策：Python 层保留。**
`mcp_link/*.pyd` 里的 42 个模块虽不可用，但**Python 是这套方案的刚需**：
- PKPM MCP 的函数要注入 Python 环境
- COM 调用要 `win32com`
- 用户脚本是 Python

不要强行改成 TypeScript。**Node 管编排，Python 管执行。**

---

## 二、六个模块的设计

### 模块 1：MCP 连接层（最优先，1-2 周）

**文件：`packages/services/src/mcp-link/`**

```typescript
// base.ts
export abstract class BaseMCPLink {
  protected port?: number;
  protected connected = false;

  abstract startMcpServer(workDir?: string, args?: string): Promise<boolean | string>;
  abstract disconnect(): void;

  async connect(workDir?: string, args?: string, timeout = 30_000): Promise<boolean | string> {
    const r = await this.startMcpServer(workDir, args);
    if (r !== true) return r;
    await waitLocalMcpReady(this.port!, 100_000);
    return this.connectMcp(timeout);
  }

  isConnected(): boolean { return this.connected; }
  protected abstract connectMcp(t: number): Promise<boolean | string>;
}

// registry.ts —— 照抄 PKPM 的 14 个函数
export async function connectToServer(
  name: string, workDir?: string, cmdArgs?: string
): Promise<boolean | string>;
export function getActiveLink(name: string): BaseMCPLink | undefined;
export function getActiveLinks(): Record<string, BaseMCPLink>;
export function isServerConnected(name: string): boolean;
export function listMcpServersConfig(): Record<string, unknown>;
export function addMcpServer(name: string, cfg: object): boolean;
export function removeMcpServer(name: string): boolean;
export function setMcpServerEnabled(name: string, enabled: boolean): boolean;
// … 共 14 个
```

**BimBaseLink 的启动发现**（照抄 plants 的四路策略）：

```
1. 显式 exePath
2. 环境变量 BIMBASE_EXE_PATH
3. 上次成功路径（持久化在 userData）
4. 自动发现，四路并行：
   ① HKCU/HKLM\...\Uninstall → InstallLocation
   ② HKCU\SOFTWARE\PKPMAgent2\...（自家配置键模型）
   ③ .p3d / .db1 文件关联 → shell\open\command
   ④ 环境变量 BIMBASE_HOME
   每个候选过 isValidRoot()（必须有启动器 + MCP 脚本）
```

**MCP 握手后必做**：生成连接简报

```
buildBriefing(serverName) →
  "you can use these categories: [建模/修改/查询/截面/…]
   and these data structures: [Point3D, Line3D, MemberInfo, …]"
```

这是省成本的杀手锏——一次告诉模型"你有什么"，省掉一轮试错。

---

### 模块 2：Python 执行器（2-3 周）

**核心需求：**

| 特性 | 为什么需要 |
|---|---|
| 会话常驻 | `rhino, script, version = get_rhino()` 要跨调用复用 |
| 按 key 分配 worker | Tekla 的 .NET 运行时不能反复加载 |
| 超时中断 | 计算可能跑几分钟 |
| 输出去噪 | 只把 `print` 内容返回给模型 |

**接口**：

```python
submit(key, code=None, file_path=None, args=None, timeout=None, workspace_dir=None) -> dict
interrupt_async(key=None) -> dict
run_editor(code=None, file_path=None, args=None) -> dict
```

**Job Object 回收**（Windows 必须）：
```python
# 子进程创建时挂到 Job Object
# 主进程退出 → 内核连坐回收，不留僵尸 python.exe
JOBOBJECT_EXTENDED_LIMIT_INFORMATION.LimitFlags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
```

> main.py 的注释说得很清楚：父进程消失时，先给主线程注 KeyboardInterrupt，
> 10 秒宽限后 `os._exit()`。因为 `asyncio.to_thread` 上的脚本可能永远结束不了。

---

### 模块 3：函数检索（1 周）

**PKPM 的机制（直接照抄）：**

```
注入的普通函数，不是工具
function_search(action: GetType | GetName | GetDescription | GetClass)
```

| action | 输入 | 输出 |
|---|---|---|
| `GetType` | — | 全部函数类别 |
| `GetName` | func_type | 该类别全部函数名 |
| `GetDescription` | func_type + func_names | 参数、返回值、示例 |
| `GetClass` | — | 数据结构（pydantic 类） |

**关键设计**：
> 「函数清单是有限且可穷尽的。对某类别执行 GetName，返回的就是该类别下完整无遗漏的函数清单。」

**这意味着「这个能力支不支持」是可查证的**，不用试探。这是防幻觉的核心机制。

---

### 模块 4：技能系统（1-2 周）

Reactor 已有 `services/skills`，扩充成三件套：

```typescript
// paths.ts
skillsRoots(): string[]          // [内置, SKILLS_EXTRA_PATHS, 用户目录]
collectSkillMetas(dirs): SkillMeta[]
fsFingerprint(mds): string       // 文件指纹缓存，避免重复扫描
resolveSkillMd(id): string | null
middlewareSources(): string[]

// preferences.ts
getDisabledSkillNames(): Set<string>
setSkillEnabled(name, enabled): Set<string>

// slash.ts
parseSlashSkillNames(text): string[]
resolveSlashSkills(text, disabled): ResolvedSlash[]
```

**SKILL.md 规范**（从校验脚本还原）：

```yaml
---
name: 最长64字符，小写连字符
description: 触发条件是唯一判据
allowed-tools: 可选
license: 可选
metadata: 可选
---
正文最长 500 行
可用资源目录：scripts/ references/ assets/
```

---

### 模块 5：中间件链（3-4 周）

Reactor 有 extension 机制，用它实现。**必做的四个**：

| 中间件 | 职责 |
|---|---|
| `skills` | 系统提示注入可用技能清单 |
| `mcpManager` | 连接状态写进提示（`plantsmcp: 已连接`） |
| `permission` | Ask / Auto / Full 三级拦截 |
| `contextCompaction` | 超阈值压缩历史 |

**权限三级**（工程场景刚需）：

```typescript
type PermissionMode = 'ask' | 'auto' | 'full';

// ask:  每个工具调用都要确认
// auto: 只确认高危（删除、计算、覆盖文件）
// full: 全自动
```

---

### 模块 6：知识库（复用 EvoFlow）

**不要重写。** 你们已有 EvoFlow 知识库（已授权）。只需对齐两个接口：

```python
knowledge_search(knowledge_base_name, keywords, semantic_query, limit) -> dict
knowledge_browse(knowledge_base_name, file_name, offset, limit) -> dict
```

**PKPM 的设计值得学的两点**：
1. **语义索引异步建**，没建好时关键词搜索不受影响（降级设计）
2. **Wiki 结构**不是文件柜：文件夹树 + 文档 + 页面级定位

---

## 三、PKPM 专属的工程知识（**最值钱的部分**）

这部分不是架构，是**踩坑记录**。照抄这些能省半年。

### 3.1 建模体系：定位骨架是平面的

```
节点（点）→ 网格（连线）→ 构件
柱依附节点，梁/墙依附网格，斜杆依附两端节点
```

**接口层已封装**：新建函数直接收 `Point2D`/`Line2D`/`Line3D`，节点网格自动补齐。

### 3.2 交叉自动打断（大坑）

新建网格/梁/墙时，若与其他相交，**PKPM 自动在交点打断成多段**。

**但返回的 `MemberInfo` 是打断前捕获的**：
- 每条输入曲线对应一个返回值
- 不含新增段
- ID 不保证还代表原来那根构件

**所以**：布置完要再操作这些构件，**不要复用创建时的返回值**，重新检索：
```
GetOneStdFlrMember(MemberKind, StdFlr)
FindBarByLine2DOrArc2D(positions, stdFlrNo)  → list[list[MemberInfo]]
```

梁还有"段/跨"之分：两端约束按**跨**设置，不按段。

### 3.3 两套入口：指定层 vs 自动识层

| 入口 | 后缀 | 层确定 | 端部标高 |
|---|---|---|---|
| 二维 | `_ToSpecifiedStdFlr` | 显式 `StdFlrNo` | 取默认值 |
| 三维 | `_WithAutoStdFlrDetection` | **由端点 z 反查** | 由端点 z 决定 |

**截图里那个马鞍面网壳就是用 `_WithAutoStdFlrDetection` 建的。**

这意味着：**做三维空间结构时，必须用带这个后缀的变体函数**，普通函数会失真。

### 3.4 端点 z 语义表（必背）

| 构件 | 端点 z 含义 | 落在哪 |
|---|---|---|
| 节点 | 节点标高 | 节点标高 |
| 柱 | P0.z 柱底 / P1.z 柱顶 | 柱顶→节点标高；柱底→柱底高 |
| 梁 | 该端**梁顶面**（非形心） | 梁端高差 |
| 墙 | 该端**墙顶** | 墙端高差（新建时固定 0） |
| 斜杆 | 该端标高 | 端部标高 |

**改标高的规则**：
- 柱顶只能通过节点标高改
- 节点标高是**共享量**：改它，挂着的梁墙斜杆一起升降
- 只改一根梁 → 改它自己的梁端高差
- 整层升降 → 改楼层组装表，别逐节点改

### 3.5 荷载符号约定

```
PX/PY/PZ 用世界坐标系，唯 PZ 以竖直向下为正
MX/MY/MZ 绕整体轴，右手螺旋为正
单位：力 kN，力矩 kN·m
```

### 3.6 计算启动是个特殊流程

```python
from PKPMAgent.software_link_kit.pkpm_calc import RunPKPMAnalyse
result = RunPKPMAnalyse()   # 或 RunPKPMAnalyse(path=r"C:\工程目录")
```

**它会自动完成**：保存模型 → 断开连接 → 启动计算 → **计算期间 PKPM 进程被关闭** → 完成后重启并重连。

**整个过程数分钟。** 这是 UI 上必须有进度提示的地方。

### 3.7 施工图绘制的偏移陷阱

```
新对象用 Handle 差集识别（绘制后 sleep(0.5) 等写入完成）
EXTMIN/EXTMAX 是全图范围（含已移走的层）
测范围一律用 EXTMIN/EXTMAX，不要用 GetBoundingBox
```

### 3.8 函数缺失时的正确姿势

**必须区分两种情况：**

| 情况 | 处理 |
|---|---|
| 函数**在清单里**，只是参数错 | 正常排错，值得重试 |
| 函数**不在清单里** | 真缺失，重试无意义 |

**固定话术**：
> PKPM MCP 接口仍在完善中，当前暂缺用于「<用户想做的事>」的函数，这一步暂时无法完成。可行的替代：<能做的部分／手动操作建议>。

**能做的先做完，只对缺失那一步叫停。**

---

## 四、实施路线（12 周）

```
Week 1-2   MCP 连接层
           · BaseMCPLink + registry
           · BimBaseLink 四路发现
           · 端口探测 + 握手 + 连接简报

Week 3-5   Python 执行器
           · 子进程池（会话常驻）
           · Job Object 回收
           · 超时中断
           · 输出捕获

Week 6     函数检索
           · function_search 四动作
           · 类别清单缓存

Week 7-8   技能系统
           · SKILL.md 加载 + 指纹缓存
           · 三根目录优先级
           · 斜杠命令

Week 9-11  中间件链
           · skills / mcpManager / permission / compaction
           · 权限三级（工程场景必须）

Week 12    知识库对接
           · 对齐 EvoFlow 接口
           · 语义索引异步降级
```

**并行可做**：把已有的 24,463 行脚本按 A/B/C/D 分类接入。

---

## 五、必须自己写、抄不到的部分

| 项 | 难度 | 说明 |
|---|---|---|
| **BIMBase MCP 服务端** | 🔴 高 | 构力给的是 SDK，要自己包成 MCP |
| **系统提示词** | 🟡 中 | agent.pyd 里，需要自己调 |
| **压缩算法** | 🟡 中 | 可用开源方案简化版 |
| **前端 UI** | 🟡 中 | 混淆无源，但有 617 条文案可参考 |
| **授权体系** | 🟢 低 | 自己设计更合适 |

**最硬的是第一项。** 整个方案成立的前提是：
> 构力给了 BIMBase 的二次开发接口（dev.pkpm.cn），且能封装成 MCP。

**这一条必须先验证。** 如果接口只能读不能写，整个"Agent 执行"就不成立，只能做"分析助手"。

---

## 六、第一周就能验证的事

```bash
# 1. 确认接口形态
访问 dev.pkpm.cn，拿到：
  - SDK 类型（C++ / C# / Python 绑定？）
  - 是否有写权限
  - 是否有事务/回滚

# 2. 最小验证
写 10 行代码：连接 BIMBase → 创建一个节点 → 读回坐标
  成功 = 路通了
  失败 = 先解决接口问题，别继续搭架构
```

**这一步不做完，后面全是空中楼阁。**
