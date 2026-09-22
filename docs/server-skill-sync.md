# 服务端技能同步契约（server-skills）

> 适用范围：新增或修改「从企业服务端拉取技能并落盘 / 启停 / 卸载」的代码前先读本文件。
> 背景与分期见 [server-skill-delivery-plan.md](server-skill-delivery-plan.md)；服务端 API 语义以 `server/` 代码为准。
> **实现进度（2026-09-22）——发现层与护栏已落，同步器未建**：
> - ✅ `SkillScope` 增加 `server`（`packages/shared/src/skills-types.ts`）。
> - ✅ `skillsService` 发现用户级 `server-skills/` 根（scope=server，与用户自建物理隔离）。
> - ✅ `$` 同名折叠 server 优先（§6.1）。
> - ✅ `deleteSkill` 对 server scope 拒绝（应走服务端卸载 API，见 §4.2 / §6）。
> - ❌ 同步器（§4.1–4.3）、CLI skillRoot（§6）、UI 卸载/更新入口（§6）：未建。
>   目录当前不存在，发现层无实体会命中；上述落地项是为同步器铺的类型与护栏。

## 1. 产品规则

| # | 规则 |
|---|------|
| R1 | 仅企业登录后（`IReactorServerService` 状态 `loggedIn`）才同步服务端技能 |
| R2 | 落盘真相 = 服务端 **落盘集** `GET /me/skills`（已安装 ∪ 默认安装 − 已 dismiss） |
| R3 | 启停 = 会话是否注入；**不删文件**（与服务端「软下架」对齐） |
| R4 | 卸载 = 服务端 `DELETE /me/skills/:name/install` + 删除本地目录；不得只删本地 |
| R5 | 管理端软下架（skill.enabled=false）：**已安装**技能文件保留（仍在落盘集），UI 经 `/me/skills/state` 差集标「已下架」；**P2 注入不因此变化**（服务端注入集语义接入后置，见 §9）；**auto_install 技能被 disabled 后不在落盘集**，按 R6 删除目录（服务端口径，见 repo.ts `deliverableSkillsFor`） |
| R6 | 管理端收回授权（不再可见/不在落盘集）→ 同步后删除本地目录 |
| R7 | 与用户自建技能物理隔离：同步/卸载**只动** `server-skills/`，永不碰 `skills/`、`.zcode/skills` |
| R8 | 同名冲突：列表两者都显示并标冲突；**同名解析**（`$` 注入、CLI 按名加载）取 server 版——server 高于 workspace/plugin/user，设计见 §6.1 |
| R9 | 服务端不可达/未登录/HTTP 失败 → **不删除**任何本地文件 |
| R10 | 用户可在设置里手动同步、启停、更新、卸载；server scope 不提供「删除到回收」语义 |

## 2. 状态所有者

| 状态 | 唯一写者 | 读取方 | 落盘位置 |
|------|----------|--------|----------|
| 服务端技能文件树 | `IServerSkillSyncService` | `skillsService` 发现、CLI skillRoots | `~/.reactor/server-skills/<name>/` |
| 启停（enable/disable） | `ISkillsService.setEnabled` | 发现层、`$`、CLI | `~/.reactor/cli/config.json` 的 `skills["<SKILL.md 绝对路径>"]` |
| 安装/卸载关系 | 服务端（经 sync 调 install API） | 服务端 SQL | `skill_installs` / `skill_dismissals` |
| 会话登录态与 accessToken | `IReactorServerService` | sync 调用前取 token | 凭据库（已有） |

**不变式**

1. 不允许第二处写 `server-skills` 目录；UI 只发命令给同步器。
2. 不允许为服务端技能新增 enabled 状态文件/内存缓存作为真相。
3. 目录解析与 `getUserZcodeSkillRoot()` 完全一致：`join(resolveUserHomeDir(), USER_DATA_DIR_NAME, "server-skills")`（env `HOME`/`USERPROFILE` → `homedir()`）。注意 `ZCODE_DATA_BASE_DIR` / `ZCODE_HOME` / `storage.dir` 覆盖项当前对 skills 根不生效——既有缺口，非本契约引入，见 [data-directory-contract.md](data-directory-contract.md) §4。
4. 工作区级目录永远不含 `server-skills`（服务端技能是用户级）。

## 3. 目录与文件布局

```
{home}/{USER_DATA_DIR_NAME}/server-skills/
  └── <skill-name>/              # name 须匹配 /^[a-z0-9]+(-[a-z0-9]+)*$/
      ├── SKILL.md               # 服务端 content（可含合成 frontmatter，落盘不再改写）
      └── <relative/path>        # 附属文件，POSIX 相对路径
```

- **无 `_meta.json`**：来源由根目录决定（scope=server），与用户技能区分。
- 单技能上限与服务端一致：文件 ≤200、单文件 512KB、总量 8MB、path ≤240；路径校验函数与服务端同语义（客户端落盘前**必须再验一次**）。

## 4. 同步时序

### 4.1 全量对齐 `sync()`

```
UI/登录钩子          IServerSkillSyncService           server(:8791)           磁盘
    │                         │                             │                    │
    │ ① sync()                │                             │                    │
    ├────────────────────────►│                             │                    │
    │                         │ ② GET /me/skills            │                    │
    │                         ├────────────────────────────►│                    │
    │                         │    skills[] + files 清单     │                    │
    │                         │ ◄────────────────────────────┤                    │
    │                         │    (失败 → offline=true,不动本地)                 │
    │                         │ ③ 对每个 name：                                      │
    │                         │    SKILL.md 内容不等则写                              ├─► server-skills/<name>/
    │                         │    附件 sha256 不一致才 GET /file                     │
    │                         │    写前 normalizeSkillFilePath + 哈希复核            │
    │                         │ ④ 删除：落盘集外的合法 name 子目录                    ─► 仅 server-skills
    │                         │ ⑤ GET /me/skills/state（只读投影，见 §5）            │
    │ ⑥ 结果 {changed,removed,offline,names,disabledNames,errors[]}                │
    │ ◄─────────────────────────│                             │                    │
```

**幂等**：重复 `sync()` 在无服务端变更时磁盘 mtime/内容不变（SKILL.md 字符串比对，附件 sha256 短路）。

**陈旧结果**：`sync()` 可并发调用；内部用**串行队列**（同一时刻只跑一次，后来的等待或合并为一次后续 sync），避免交叉删除/写入撕裂。

### 4.2 单技能卸载 `uninstall(name)`

1. `DELETE /me/skills/:name/install`（服务端写 dismissal，防止 auto_install 塞回）。
2. 成功后删除 `server-skills/<name>/`（校验 name pattern；只删该子树）。
3. 失败（非 404）则**不删本地**，错误上抛（避免「服务端仍安装、本地已空」下次同步又写回）。
4. 404 视为已卸载，仍删本地（清理残留）。

### 4.3 单技能更新 `refreshFromServer(name)`

1. 重新 GET `/me/skills` 或详情，对该技能执行与 4.1 ③ 相同的落盘。
2. 成功后 `POST /me/skills/:name/refresh` 使 `hasUpdate` 归位。

### 4.4 启停 `setEnabled`（不属同步器）

走现有 `ISkillsService.setEnabled({ skillId, scope: "server", enabled })`，写路径 key 的 disable override。同步器**不**调用服务端 `/enabled`（P2）。

### 4.5 触发时机

| 时机 | 动作 |
|------|------|
| 企业登录成功 | 后台 `sync()`（失败只记日志，不回滚登录） |
| 启动且已登录 | 后台 `sync()` 一次 |
| 设置页手动同步 | `sync()` + UI 结果 |
| 安装/更新/卸载 mutation 后 | 对应 mutation 自身保证磁盘/服务端一致；随后可选 `sync()` |
| 未登录 / 登出 | **不**调用 sync；**不**清空 `server-skills`（保留离线可用副本；再次登录对齐） |

> 登出保留文件：与 R9 一致；若产品要求「登出即回收」，属独立决策，需在本契约改 R 语义后再实现。

## 5. 服务端 API 使用面（P2）

| 用途 | 方法 | 说明 |
|------|------|------|
| 落盘集 | `GET /me/skills` | 响应 `skills[{name,title,description,content,version,disableModelInvocation,files[{path,size,sha256,executable}]}]` |
| 附件 | `GET /me/skills/:name/file?path=` | `{file:{content\|contentB64,sha256,...}}`；sha256=**解码后字节** |
| 卸载 | `DELETE /me/skills/:name/install` | 幂等；写 dismissal |
| 更新归位 | `POST /me/skills/:name/refresh` | 可选 |
| 安装（若做 catalog） | `POST /me/skills/:name/install` | P2.5 |
| 下架投影（只读） | `GET /me/skills/state` | `{skills:[{name,enabled,disableModelInvocation}]}`；落盘集 − state 集 = 已下架。仅作 UI 徽标等展示，**不**参与落盘/启停决策 |

鉴权与传输：`Authorization: Bearer <accessToken>`。HTTP 实现**扩展**
`packages/services/src/reactor-server/reactorServerClient.ts` 的 `createReactorServerClient`（复用其
`request()` 的 `x-new-token` 续期与错误映射），不得新建第二个 fetch/鉴权链路。token 来源：
`ICredentialService` 的 `REACTOR_SERVER_CREDENTIAL_KEYS`（`reactor:serverUrl` / `reactor:accessToken`），
登录态判定用 `IReactorServerService.getStatus()`；token 不出服务边界，UI 只调同步器接口。

## 6. 发现与注入

| 层 | 改动 |
|----|------|
| `SkillScope`（shared） | 增加 `"server"` |
| `skillsService` 发现 | user 级根增加 `server-skills`；`scope: "server"` |
| CLI 发现根（`resolveDefaultSkillRoots`） | user 级 `server-skills`，`source: "remote"`；priority 位于 extraRoots 之后、用户级两根之前——first-match 语义下 server 同名优先（§6.1） |
| `deleteSkill` | `scope=server` → **拒绝**（应走 uninstall，见 §4.2） |
| UI | 徽标「服务端」；操作为启停/更新/卸载/同步，无「删除」 |

注入不走 `skillsOverride`：CLI 发现根进列表后，既有 enabled map 与 Skill 工具链路自动生效。

### 6.1 同名解析（`$` 注入 / CLI 按名加载）

同名技能跨来源并存时（R8），**解析**（不是列表）优先级：

| 路径 | 机制 |
|------|------|
| UI `$` 注入（`skillsService.buildPromptContext`） | mentioned+enabled 集合内按 name 去重，保留 scope 序 **server > workspace > plugin > user** 的第一条 |
| CLI `loadSkill`（`/skill`、Skill 工具） | 发现根 first-match：server 根 priority 位于 extraRoots 与用户级根之间，天然优先，不改 `loadSkill` 逻辑 |

两条路径行为一致：同名都取 server 版。CLI 列表仍按 path 保留全部同名（既有语义不变，
见 `adapters/src/skills/index.ts` 的 path-keyed 去重注释）。

**为什么不排 workspace > server**：CLI 现有 root 顺序是 user(20/30) 先于 project(40/50)，要让
workspace 优先于 server 就必须调换既有 user/project 顺序，改变存量同名解析行为，超出 P2 范围。
若产品要求「项目本地覆盖企业下发」，属独立决策：改本节顺序 + `roots.ts` 插入位置 + UI 折叠 map 三处。

## 7. 失败语义

| 情况 | 行为 |
|------|------|
| 网络错误 / 5xx / 未登录 | `sync()` 返回 `offline: true`，**零删除零写盘** |
| 401 / 403（token 失效或授权变化） | 同样零删除零写盘；结果带 `authExpired: true`，UI 提示重新登录（区别于「离线」，避免用户看到永远同步失败却不知原因） |
| 单个附件 404 或 sha 不符 | 跳过该文件，记入 `errors[]`，不写半套；技能其它文件继续 |
| SKILL.md 写失败 | 跳过该技能，继续其余 |
| name 非法 / 路径越界 | 拒绝该项，不落盘 |
| 目录占用导致 rm 失败 | 记入 `errors[]`，下次 sync 重试 |
| 并发 sync | 串行队列，见 §4.1 |

## 8. 验收场景

1. **登录同步**：企业登录成功后，`server-skills` 出现服务端落盘集目录；设置列表 scope=server。
2. **附件增量**：本地已有附件 sha 一致时不发起 `/file`；改服务端文件后仅重拉变化附件。
3. **二进制附件**：`contentB64` 解码后写盘，`sha256(本地字节) === 清单 sha256`。
4. **离线不删**：断网 `sync()` → 本地文件数量与内容不变，`offline: true`。
5. **软下架**：admin 关 enabled（已安装技能）→ 文件仍在；列表标「已下架」（`/me/skills/state` 差集）；P2 注入不变（R5）。auto_install 技能被 disabled → 不在落盘集，`sync()` 删目录。
6. **硬收回**：技能从落盘集消失 → `sync()` 删除对应目录；用户 `skills/` 同名目录不受影响。
7. **卸载**：设置点卸载 → 服务端 install 删除 + 本地目录删除；再 `sync()` 不被塞回。
8. **更新**：`hasUpdate` 时点更新 → 仅变更文件落盘 + `POST refresh`。
9. **同名**：`skills/foo` 与 `server-skills/foo` 并存；`$foo` 注入 server 版，CLI `/skill` 同名也解析到 server 版；列表两者都显示。
10. **卸载护栏**：对 server 技能调用 `deleteSkill` 得到明确错误；用户自建仍可删。
11. **路径安全**：清单含 `../` 或绝对路径的附件不落盘。
12. **未登录**：不触发同步；登录前已有的 `server-skills` 不被清空。

## 9. 有意保留 / 不在本契约

| 项 | 原因 |
|----|------|
| `/me/skills/state` 参与注入过滤、workspace prefs | P2 只读取作「已下架」徽标投影；注入集语义与多机一致后置 |
| `POST /me/skills/:name/use` 用量 | P4 |
| catalog/featured/bundles/favorite | P2.5 市场 UI |
| `skill-sync` archive 通道 | 与 HTTP 下发无关 |
| 工作区内 `.zcode/skills` | 用户/项目自建，见数据目录契约 |
