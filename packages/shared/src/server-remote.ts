import { z } from "zod";

export const SERVER_REMOTE_PROTOCOL_VERSION = 1;

export const serverRemoteWorkspaceInfoSchema = z.object({
  path: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
  workspaceIdentity: z.string().trim().min(1).optional(),
});

export const serverRemoteInfoSchema = z.object({
  serverId: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  version: z.string(),
  protocolVersion: z.literal(SERVER_REMOTE_PROTOCOL_VERSION),
  authRequired: z.boolean(),
  workspaces: z.array(serverRemoteWorkspaceInfoSchema),
  capabilities: z.object({
    desktopContinuous: z.literal(true),
    websocketRpc: z.literal(true),
    // 旧 Server 缺少新增 dynamic event，必须先声明能力再订阅，避免异常打进对端读循环。
    processResourceTelemetry: z.boolean().optional(),
  }),
  /**
   * 服务端视角的身份服务地址（如容器内的 http://identity:8791）。
   *
   * Web 端登录由**服务端**转发到 identity，所以这个地址只在服务端可达；
   * 有值时 Web 登录页会锁定该地址并隐藏输入框，用户只需填账号密码。
   * 桌面端不使用该字段（它的登录请求从用户电脑发出）。
   */
  identityUrl: z.string().trim().min(1).optional(),
  /** 每用户工作区根目录（Web 端配额模型），用于前端展示与能力发现。 */
  userWorkspaceRoot: z.string().trim().min(1).optional(),
});

export type ServerRemoteWorkspaceInfo = z.infer<typeof serverRemoteWorkspaceInfoSchema>;

export type ServerRemoteInfo = z.infer<typeof serverRemoteInfoSchema>;

export const serverRemoteHostCapabilitySchema = z
  .object({
    capability: z.string().trim().min(1),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type ServerRemoteHostCapability = z.infer<typeof serverRemoteHostCapabilitySchema>;
