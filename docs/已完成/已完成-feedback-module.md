# 反馈 / 需求受理模块（FBK）契约

覆盖「问题上报」「给产品提需求」从桌面端提交，到自建服务端落库，再到管理台受理的完整闭环。
动手前先读本文；它跨 `packages/**`（客户端）与 `server/**`（独立 workspace，服务端 + 管理台）两个边界。

## 1. 现状与问题

客户端早就是一整套工单体系，但**打的是官方外部后端**：

| 环节 | 现状 |
| --- | --- |
| 入口 | 帮助菜单「问题上报」「给产品提需求」→ `feedbackStore.openSubmit / openFeatureRequest` |
| 表单 | `packages/ui/src/feedback/FeedbackSubmitForm.tsx`、`FeatureRequestDialog.tsx` |
| 提交/列表/评论/附件 | `packages/services/src/feedback/feedbackService.ts`（RPC）+ `feedbackHttpClient.ts`（HTTP） |
| 协议与类型 | `packages/shared/src/feedback.ts`（工单类型、状态、列表、事件、附件） |
| 落库 | 官方 API，`resolveApiBaseUrl()` = `apiBaseUrl` ?? `ZCODE_FEEDBACK_API_BASE` ?? 官方 `/api/v1` |
| 自建服务端 | **没有** feedback 模块；管理台**没有**受理页面 |

结果是：Reactor 自己收不到用户上报，管理台自然无从受理。

## 2. 闭环设计

```text
桌面端表单 ──POST /api/v1/feedback/ticket──▶ identity（公开段）──▶ PG feedback_ticket
    │                                                                    │
    └─ 附件 ──PUT /api/v1/feedback/ticket/:id/attachment──▶ 磁盘 + feedback_attachment
                                                                         │
                                                                  管理台受理
                                                                         │
管理台 ◀──GET/PATCH/POST /admin/feedback/*──── requireAdmin（鉴权段）
```

状态所有者只有**服务端 PG** 一张表；客户端不缓存事实，管理台不落本地状态。
附件字节落服务端磁盘（`REACTOR_FEEDBACK_FILE_DIR`，卷 `feedback-files`），PG 只存元数据。

## 3. 接口

### 3.1 客户端面（`createFeedbackPublicRoutes`，挂 identity **公开段**）

沿用客户端既有路径与字段（`packages/shared/src/feedback.ts`），客户端零协议改动：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/feedback/ticket` | 建工单；body = `CreateFeedbackTicketInput` |
| GET | `/feedback/ticket?status=&type=&mine=&offset=&limit=` | 列表，返回 `FeedbackListResult` |
| GET | `/feedback/ticket/:id` | 详情（含 comments / events / attachments） |
| POST | `/feedback/ticket/:id/message` | 用户追加消息（评论，`is_staff=false`） |
| PUT | `/feedback/ticket/:id/attachment?kind=&message_id=` | **附件字节直传**（body = 原始字节流），201 返回 `attachment_id/file_name/size/sha256` |
| GET | `/feedback/ticket/:id/attachments/:aid` | 用户侧取回附件字节（路径带工单 id，不可枚举） |
| POST | `/feedback/attachment/upload-credential` | 仅对**仍走 OSS 协议的旧客户端**回 400 + `attachments_unsupported`；新版客户端命中企业基址时不会再打这里 |

**鉴权口径**：客户端打的是 `getAuthHeaders()`，自建端优先用**企业令牌**（`REACTOR_SERVER_CREDENTIAL_KEYS.accessToken`），
拿不到才回落官方 `zcodejwttoken`——自建服务端只认自家 identity 签发的 JWT，官方 token 验不过。
这段**不强制 Bearer**：带了就解析 `claims` 填报告人，解析不了按匿名 + `X-Device-Mid` 记录。
挂在强制鉴权段里会让匿名上报全部 401，这是它必须放公开段的原因。

**报告人身份只信令牌**：`reporter_uid` / `reporter_dept` 由 `claims.sub` 与 `claims.deptId → departments.path`
在服务端查出，客户端自报的 `reporter` / `environment` 一律不采信（冒烟有伪造断言）。

### 3.2 管理面（`createFeedbackAdminRoutes`，挂 identity **鉴权段之后** + `requireAdmin`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/feedback/tickets?status=&type=&q=&offset=&limit=` | 受理列表（`q` 匹配标题/正文） |
| GET | `/admin/feedback/tickets/:id` | 详情（含报告人设备信息、评论、事件） |
| PATCH | `/admin/feedback/tickets/:id` | 状态 / 严重度 / 负责人流转，写事件 |
| POST | `/admin/feedback/tickets/:id/messages` | 管理端回复（`is_staff=true`），写事件 `staff_replied` |
| GET | `/admin/feedback/tickets/:id/attachments/:aid/download` | 管理端下载附件（写审计 `feedback.attachment.download`） |

## 4. 数据

| 表 | 职责 |
| --- | --- |
| `feedback_ticket` | 工单主体：id(UUID TEXT)、标题、正文、type/severity/module/status、reporter/device jsonb、reporter_uid、reporter_dept、assignee、device_mid、时间戳 |
| `feedback_comment` | 消息（双向）：`is_staff` 区分管理员回复；`message_id` 供附件绑定 |
| `feedback_event` | 状态/指派/回复的事件流，供详情页时间线 |
| `feedback_attachment` | 附件元数据：`stored_name`（磁盘 uuid）、`file_name`（用户原始名，UTF-8 无损）、`size_bytes`、`sha256`、`content_type`、`kind`；字节在 `REACTOR_FEEDBACK_FILE_DIR` |

`contact` 列**保留但不写入**：产品决策下联系方式字段已下线（客户端表单与提交链路均已删除），
列只为展示历史数据而留，新工单恒为 NULL。

状态取值**必须**与 `packages/shared/src/feedback.ts` 的 `FeedbackTicketStatus` 完全一致（中文枚举，共 9 个）：
`已提交 / 信息不足 / 已采纳 / 答复关闭 / 已归档 / 已拒绝 / 开发中 / 已解决 / 已上线`。
新增状态前先改 shared 的类型，否则客户端类型对不上。

建表沿用 `schema.ts` 的 `CREATE TABLE IF NOT EXISTS` 幂等风格，无迁移框架；补列写 `ADD COLUMN IF NOT EXISTS`。

## 5. 管理台

- 页面 `server/packages/admin/src/pages/FeedbackInbox.tsx`：列表（状态/类型筛选 + 关键字）+ 详情面板（正文、设备信息、时间线）+ 状态流转 + 回复。
- 服务 `server/packages/admin/src/services/feedback.ts`，复用 `http/client.ts` 的 Bearer + 续期。
- 菜单 `menu.tsx`：key `feedback`，角色 `AH`（platform_admin + dept_head 都要能受理）；
  **`/me/nav` 白名单必须同步加 `feedback`**——只改一边页面永不显示（`t187` 对这个跨包契约做双向断言）。

## 6. 有意的取舍

- **附件走字节直传，不自建对象存储**：原协议是「OSS 直传凭证」（`/upload-credential` 返回阿里云表单参数，
  客户端把字节传 OSS），自建服务端没有这套 OSS。改法是客户端在企业基址下**改道** `PUT .../attachment`
  直接推字节流，服务端流式落盘（`Readable.fromWeb` + 边写边算哈希 + `.part` 后再 rename，避免半截文件入库）。
  仅在 `getBaseUrl()` 给出企业基址时改道，官方后端/开源用法仍走 OSS，一行协议都没动。
  `PUT` 返回 400 才降级：客户端把「日志没传上去」记成系统评论，不把已建好的工单报成提交失败。
  后缀白名单 `.zip .png .jpg .jpeg .webp .gif .txt .log .json .md .pdf .csv`，单文件上限
  `REACTOR_FEEDBACK_MAX_BYTES`（默认 1GB）。保留 `/upload-credential` 只为让**旧客户端**拿到明确的
  `attachments_unsupported` 而不是 404。
- **客户端接入方式**：`createFeedbackService` 的 `apiBaseUrl` 在企业登录场景下由自建服务端 endpoint 派生，
  不改协议只改基址；`ZCODE_FEEDBACK_API_BASE` 仍可显式覆盖（本地调试用）。
- **不做「我的工单」账号体系**：一期 `mine` 语义退化为按 `X-Device-Mid` 过滤；
  报告人归属改用令牌里的 `reporter_uid` / `reporter_dept` 在管理台展示，客户端仍不带账号语义。

## 7. 验收场景

1. 桌面端帮助菜单「问题上报」提交一条，管理台列表出现该工单，状态为「已提交」。
2. 「给产品提需求」提交的工单 `type=feature`，管理台可按类型筛选出来。
3. 管理台把状态改成「开发中」，详情时间线出现 `status_changed` 事件；客户端再拉详情能看到新状态。
4. 管理台回复一条，客户端详情里该评论 `is_staff=true`，且事件流出现 `staff_replied`。
5. 无 token 的 `POST /feedback/ticket` 也能建单；带**企业令牌**提交时 `reporter_uid` 取 `claims.sub`、
   `reporter_dept` 取 `departments.path`，且伪造的客户端自报 `reporter` 被忽略。
6. 带企业基址的 `uploadFile` 走 `PUT .../attachment`：201、字节与 sha256 一致、中文文件名无损还原、
   `.exe` 等非白名单后缀回 400；用户面与管理面各自下载到的字节一致。
7. 未登录访问 `/admin/feedback/*` 返回 401；非 `platform_admin`/`dept_head` 返回 403。
8. 冒烟 `pnpm --filter @reactor/server smoke:feedback` 在无 PG 时 SKIP、有 PG 时全绿。
