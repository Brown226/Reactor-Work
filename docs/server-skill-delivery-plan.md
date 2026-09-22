# P2 技能下发 · 实施计划

> **状态**：规划（契约见 [server-skill-sync.md](server-skill-sync.md)）　**日期**：2026-09-22
> **范围**：主仓 `Reactor-Work` 的服务端技能下发（同步 + 发现 + 设置 UI）；服务端 API 已存在，本计划**不改** `server/`。
> **依据**：[服务端接线-方案-v1.md](服务端接线-方案-v1.md) §1 R4/R5、§4.3；旧项目 `Reactor-Desktop` 实现与踩坑；主仓 skills 体系现状。
> **原则**：借旧项目的**同步协议与安全语义**，不搬它的 **Electron main + sidecar 接线**。

---

## 1. 目标与非目标

### 目标（P2 验收）

1. 企业登录后，从服务端**增量拉取**已安装/默认安装技能，落盘到用户级独立目录 `server-skills/`。
2. 技能在列表中 **scope=server、可区分来源**；同名与用户自建共存并提示冲突。
3. 支持**安装 / 卸载 / 更新 / 启停 / 手动同步**；启停不影响用户自建技能。
4. 离线/服务端不可达时**绝不误删**本地文件。
5. 管理端**软下架**（enabled=false）留文件不注入；**授权收回**才删目录。
6. 会话注入走主仓既有 CLI 发现根，**不新增**第二套注入通道。

### 非目标（明确不做）

| 项 | 原因 |
|----|------|
| 技能市场 catalog/精选/套件/收藏 | 服务端 API 已有，UI 加法后置 P2.5 |
| 服务端启停 prefs / workspaceKey | 主仓 enabled map 已是唯一写点；多机一致另议 |
| 使用量上报 `POST /me/skills/:name/use` | 属 P4 用量 |
| Agent 下发 | P3 |
| 改 `skill-sync`（SSH/Docker archive） | 方案 §7 明确不复用 |
| 周期轮询 / 推送 | 与旧项目一致：登录/变更/手动触发即可 |

---

## 2. 旧项目路线取舍（为何不照搬）

| 旧项目做法 | 判定 | 主仓落点 |
|------------|------|----------|
| 落盘集 + 附件 sha256 按需拉 | **采纳** | 同步器实现该协议 |
| 离线不动本地 / 软下架留文件 / 卸载写 dismissal | **采纳** | 同步器 + 调 `DELETE install` |
| 路径 `normalizeSkillFilePath` 双端校验 | **采纳** | 落盘前再校验 |
| 混目录 `<userData>/skills` | **拒绝** | 独立 `~/.reactor/server-skills/` |
| `REACTOR_SKILLS_DIR` + `skillsOverride` | **拒绝** | CLI `skillRoots` + `skillsService` 发现根 |
| 状态文件 `.reactor-skills-state.json` | **拒绝** | 复用 `cli/config.json` skills enabled map |
| Electron main `SkillsSync` 类 | **拒绝** | `packages/services` 的 `IServerSkillSyncService` |
| 市场全量 UI | **后置** | 设置页最小列表 |

---

## 3. 状态所有者（摘要）

完整契约见 `server-skill-sync.md` §2。

| 状态 | 唯一写者 | 落盘 |
|------|----------|------|
| 服务端技能文件树 | `IServerSkillSyncService` | `{数据根}/server-skills/<name>/` |
| 启停 | 既有 `skillsService.setEnabled` | `~/.reactor/cli/config.json`（路径 key） |
| 安装/卸载关系 | 服务端 `skill_installs`（经 install API） | 服务端 DB |
| 登录令牌 / 服务端地址 | `IReactorServerService` | 凭据库（已有） |

**禁止**：UI 直接写 `server-skills`；同步器写 `skills/`（用户自建）；再造第二份 enabled 状态。

---

## 4. 架构接线

```
IReactorServerService ──(accessToken)──► IServerSkillSyncService
                                              │ GET /me/skills
                                              │ GET /me/skills/:name/file
                                              │ POST|DELETE .../install
                                              ▼
                                   ~/.reactor/server-skills/
                                              ▲
                    ┌─────────────────────────┴─────────────────────────┐
              skillsService.list                              CLI skillRoots
           (scope=server, 卸载护栏)                      (user 级 server-skills)
                    └─────────────────────────┬─────────────────────────┘
                                              ▼
                              SkillsSection / $ 提及 / Skill 工具
```

- **One owner**：磁盘文件只有同步器写；启停只有 skillsService 写。
- **One path**：发现走现有 `discoverSkills` / `resolveDefaultSkillRoots`，不另建加载器。
- **跨模块边**：services → shared 契约类型；UI → `ISkillsService` + 新 `IServerSkillSyncService`；CLI adapters → contracts。

---

## 5. 实施步骤（每步可验收）

| # | 步骤 | 产出 | 验收 |
|---|------|------|------|
| 1 | 本计划 + 契约 | `server-skill-delivery-plan.md`、`server-skill-sync.md` | 文档评审 |
| 2 | shared 类型 | `SkillScope += "server"`；CLI `SkillSource` 映射 | typecheck |
| 3 | 同步器服务 | `IServerSkillSyncService` + client HTTP 面 + 落盘 | 服务层断言 |
| 4 | 发现根 | `skillsService` + CLI `roots.ts` 加 `server-skills` | 列表出现、`$`/Skill 可加载 |
| 5 | 删除/卸载护栏 | server scope 拒绝 `deleteSkill` rm；UI 显示「卸载」 | 误删不可能 |
| 6 | 设置 UI | 服务端技能区：列表/启停/更新/卸载/手动同步 | 真机 |
| 7 | 登录挂钩 | 登录成功后台同步；失败不阻断登录 | 真机 |
| 8 | 回归 | typecheck / lint / architecture / 行为清单 | 见 §7 |

---

## 6. 关键决策（含取舍）

1. **独立目录 `{数据根}/server-skills`**：与 `skills/` 物理隔离，卸载/同步永不碰用户自建（R5）。
2. **启停 v1 本地 map、不接服务端 prefs**：避免旧项目「三处状态」；服务端 `/me/skills/:name/enabled` 留到多机一致再接。
3. **同名解析 server 高于其余来源**（workspace/plugin/user；`$` 折叠与 CLI 按名加载一致）：企业下发优先。不排「workspace > server」的原因是 CLI 现有 user/project root 顺序无法表达该序且改动会波及存量技能，理由见契约 §6.1。
4. **附件增量用 sha256**，SKILL.md 用内容不等则写：与旧项目一致；哈希口径 = 解码后字节（旧项目二进制事故）。
5. **卸载 = `DELETE install` + 删本地目录**：只 rm 本地会被 `auto_install` 塞回（旧项目 dismissal 教训，调 API 由服务端写 dismissal）。
6. **软下架 vs 硬收回**：admin 对**已安装**技能 enabled=false → 文件保留、`/me/skills/state` 差集标「已下架」、P2 注入不变；不可见或 auto_install+disabled → 删目录。对齐服务端 `deliverableSkillsFor`。
7. **无轮询**：登录成功、mutation 后、手动、启动后台一次。

---

## 7. 验收场景（契约 §8 展开）

1. 登录 → 自动同步 → 设置出现服务端技能，徽标「服务端」。
2. 默认安装/管理端预装的技能 → 目录出现 `SKILL.md`+附件 → 列表可启停（P2 不提供 catalog 安装 UI，安装 API 见契约 §5 标 P2.5）。
3. 更新（hasUpdate）→ 仅变化文件重下；无关附件不重下。
4. 卸载 → 本地目录消失、服务端 install 删除；再次同步**不会**被 auto_install 塞回。
5. 断网同步 → `offline`，本地完整保留。
6. 管理端软下架 → 已安装技能文件仍在、列表标「已下架」；P2 注入不变；auto_install 技能被 disabled → 目录删除（契约 R5）。
7. 管理端收回授权 → 同步后目录删除。
8. 用户自建同名技能 → 两侧都可见；`$name` 与 CLI `/skill` 同名都取 server 版（契约 §6.1）。
9. 用户点「删除」server 技能 → 只能走「卸载」，无法 rm 到用户目录外。
10. 未登录 → 无 server 技能；用户自建不受影响。

---

## 8. 风险与未决

| # | 项 | 处置 |
|---|----|------|
| U-S1 | workspaceKey 与服务端技能安装状态 | P2 不传 workspaceKey（全局），多工作区覆盖后置 |
| U-S2 | `hasUpdate` 刷新需 `POST /refresh` | 更新动作末尾调用 |
| U-S3 | 前端目录浏览安装全量市场 | P2 仅「已下发 + 手动同步」；catalog UI 后置 |
| U-S4 | CLI 契约 scope 字段与 shared 不一致 | 映射 `SkillSource="remote"` 或同步扩类型，改 contracts 注释 |
| U-S5 | 架构策略 `services` 非 managed | 新服务挂现有 `services/src/server-skills/`，不新建 managed module |

---

## 9. 与其它文档关系

| 文档 | 关系 |
|------|------|
| [server-skill-sync.md](server-skill-sync.md) | **契约正本**：状态所有者、时序、接口、验收 |
| [服务端接线-方案-v1.md](服务端接线-方案-v1.md) | 产品规则与分期；本文只展开 P2 |
| [data-directory-contract.md](data-directory-contract.md) | 目录命名与用户级/工作区级边界 |
| [../server/README.md](../server/README.md) | 服务端技能 API 语义（落盘集/注入集） |
