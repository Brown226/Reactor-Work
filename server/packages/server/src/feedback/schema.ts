/**
 * 反馈 / 需求数据域（FBK）：桌面端「问题上报」「给产品提需求」在自建服务端的落库。
 *
 * 为什么三张表而不是一张 JSON：
 *  - `feedback_ticket` 是工单主体（管理台列表/筛选的对象）；
 *  - `feedback_comment` 是**双向**消息（用户补充 + 管理员回复共用一张表，`sender_type` 区分），
 *    因为客户端的详情视图就是拿 messages 组装时间线的（见 feedbackHttpClient.mapTicketDetail）；
 *  - `feedback_event` 只记状态/指派这类**流转**，管理台要能回答"谁在什么时候改了什么"，
 *    消息表回答不了这个问题（回复不等于流转）。
 *
 * id 口径：
 *  - 工单 id 是 TEXT（uuid）——客户端把它当字符串贯穿全程（ticket_id），用序列号会让
 *    预测 id 变成可能（工单号不该可枚举）；
 *  - 消息与事件用 BIGSERIAL——客户端和管理台都按 number 消费。
 *
 * status 取值必须与 packages/shared/src/feedback.ts 的 FeedbackTicketStatus 一致（中文枚举），
 * 客户端 mapFeedbackStatus 是按原文透传的，服务端写什么用户就看到什么。
 */
import type { IdentityDb } from "../identity/db.js";

export async function ensureFeedbackSchema(db: IdentityDb): Promise<void> {
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS feedback_ticket (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      -- bug / usage / feature / performance（客户端 content.category）
      type TEXT NOT NULL,
      -- P1-高 / P2-中 / P3-低
      severity TEXT,
      -- 模块分类（客户端 content.function），如 "模型配置 / API Key"
      module TEXT,
      -- 状态：中文枚举，见 docs/feedback-module.md §4
      status TEXT NOT NULL DEFAULT '已提交',
      contact TEXT,
      -- 提交时上报的设备/环境快照（客户端 environment 原样存下，详情页要展示）
      environment JSONB,
      -- 有身份时填展示名；匿名提交为 null
      reporter_display TEXT,
      device_mid TEXT,
      assignee_id TEXT,
      assignee_display TEXT,
      -- 有新动作未被管理台看过：列表靠它标红点
      unread BOOLEAN NOT NULL DEFAULT false,
      last_user_activity_at TIMESTAMPTZ,
      locale TEXT,
      source TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.pool.query(`
    CREATE INDEX IF NOT EXISTS idx_feedback_ticket_lookup
      ON feedback_ticket (created_at DESC, id DESC);
  `);
  await db.pool.query(`
    CREATE INDEX IF NOT EXISTS idx_feedback_ticket_status
      ON feedback_ticket (status, created_at DESC);
  `);
  await db.pool.query(`
    CREATE INDEX IF NOT EXISTS idx_feedback_ticket_device
      ON feedback_ticket (device_mid);
  `);

  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS feedback_comment (
      id BIGSERIAL PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES feedback_ticket(id) ON DELETE CASCADE,
      -- 客户端会拿原始 message_id 再请求附件上传凭证，必须原样保存
      message_id TEXT NOT NULL,
      -- user / staff：客户端按 sender_type === "staff"|"admin" 判定 is_staff
      sender_type TEXT NOT NULL DEFAULT 'user',
      author_user_id TEXT,
      author_display_name TEXT,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.pool.query(`
    CREATE INDEX IF NOT EXISTS idx_feedback_comment_ticket
      ON feedback_comment (ticket_id, created_at, id);
  `);

  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS feedback_event (
      id BIGSERIAL PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES feedback_ticket(id) ON DELETE CASCADE,
      -- created / status_changed / assignee_changed / staff_replied / user_replied
      type TEXT NOT NULL,
      summary TEXT NOT NULL,
      actor_display_name TEXT,
      payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.pool.query(`
    CREATE INDEX IF NOT EXISTS idx_feedback_event_ticket
      ON feedback_event (ticket_id, created_at, id);
  `);

  // 后续补列沿用 updates/audit 的幂等写法：
  //   ALTER TABLE feedback_ticket ADD COLUMN IF NOT EXISTS <col> <type>;
}
