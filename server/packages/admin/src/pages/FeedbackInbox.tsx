// 反馈与需求受理（FBK / 管理台「系统」组）：桌面端「问题上报」「给产品提需求」的受理台。
// 数据真源：服务端 GET/PATCH /admin/feedback/tickets（platform_admin）。
// 红点语义由服务端维护：打开详情即熄（unread=false），用户补充消息会重新点亮。

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowsClockwise,
  ChatCenteredText,
  ChatsCircle,
  MagnifyingGlass,
  PaperPlaneTilt,
} from "@phosphor-icons/react";
import {
  FEEDBACK_SEVERITIES,
  FEEDBACK_STATUSES,
  FEEDBACK_TYPES,
  feedbackApi,
  feedbackTypeLabel,
  type FeedbackListResult,
  type FeedbackTicketDetail,
} from "../services/feedback";
import { toast } from "../lib/toast";
import { PageHead, SkeletonRows } from "../ui";
import { ToneBadge, type Tone } from "../components/reactor";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";

/** 状态 → 徽标色：受理人靠颜色判断"这张单还欠我什么"，一律灰会看不出优先级。 */
const STATUS_TONE: Record<string, Tone> = {
  已提交: "info",
  信息不足: "warn",
  已采纳: "accent",
  答复关闭: "neutral",
  已归档: "neutral",
  已拒绝: "danger",
  开发中: "accent",
  已解决: "success",
  已上线: "success",
};

const TYPE_TONE: Record<string, Tone> = {
  bug: "danger",
  usage: "info",
  feature: "accent",
  performance: "warn",
};

const SEVERITY_TONE: Record<string, Tone> = { "P1-高": "danger", "P2-中": "warn", "P3-低": "neutral" };

const ALL = "all";
const PAGE_SIZE = 50;

const fmtTime = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 设备/环境快照里最有排查价值的几项；整块 JSON 太长，点开详情先给人能读的。 */
function environmentLine(environment: Record<string, unknown> | null): string {
  if (!environment) return "—";
  const pick = (key: string): string | undefined => {
    const value = environment[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  return [
    pick("app_version") && `v${pick("app_version")}`,
    pick("platform"),
    pick("os_version"),
    pick("agent_model_display") ?? pick("agent_model"),
    pick("os_arch"),
  ]
    .filter(Boolean)
    .join(" · ") || "—";
}

export function FeedbackInbox() {
  const [status, setStatus] = useState<string>(ALL);
  const [type, setType] = useState<string>(ALL);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<FeedbackListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FeedbackTicketDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [updating, setUpdating] = useState(false);

  const params = useMemo(
    () => ({
      ...(status !== ALL ? { status } : {}),
      ...(type !== ALL ? { type } : {}),
      ...(unreadOnly ? { unread: true } : {}),
      ...(query.trim() ? { q: query.trim() } : {}),
    }),
    [status, type, unreadOnly, query],
  );

  const loadList = useCallback(
    async (nextOffset = offset) => {
      setLoading(true);
      try {
        const res = await feedbackApi.list({ ...params, limit: PAGE_SIZE, offset: nextOffset });
        setData(res);
        setOffset(nextOffset);
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [params, offset],
  );

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const res = await feedbackApi.get(id);
      setDetail(res.ticket);
      // 打开详情即熄红点：同步把列表里那一行也改掉，避免红点在当前页还亮着。
      setData((current) =>
        current
          ? {
              ...current,
              tickets: current.tickets.map((item) =>
                item.id === id ? { ...item, unread: false } : item,
              ),
            }
          : current,
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList(0);
    // 过滤条件变化时回到第一页重新查询
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const selectTicket = (id: string): void => {
    setSelectedId(id);
    setReply("");
    void loadDetail(id);
  };

  const changeStatus = async (nextStatus: string): Promise<void> => {
    if (!detail) return;
    setUpdating(true);
    try {
      await feedbackApi.patch(detail.id, { status: nextStatus });
      toast.ok(`状态已更新为「${nextStatus}」`);
      await loadDetail(detail.id);
      await loadList(offset);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUpdating(false);
    }
  };

  const changeSeverity = async (nextSeverity: string): Promise<void> => {
    if (!detail) return;
    setUpdating(true);
    try {
      await feedbackApi.patch(detail.id, { severity: nextSeverity });
      toast.ok(`严重度已更新为「${nextSeverity}」`);
      await loadDetail(detail.id);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUpdating(false);
    }
  };

  const sendReply = async (): Promise<void> => {
    if (!detail || !reply.trim()) return;
    setSending(true);
    try {
      await feedbackApi.reply(detail.id, reply.trim());
      setReply("");
      toast.ok("回复已发送，客户端详情里会以「客服已回复」呈现");
      await loadDetail(detail.id);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const rows = data?.tickets ?? [];
  const total = data?.total ?? 0;
  const unreadCount = rows.filter((item) => item.unread).length;

  return (
    <div>
      <PageHead
        title="反馈与需求"
        desc="桌面端「问题上报」与「给产品提需求」的受理台：按状态/类型筛单、改流转、回消息；用户补充会重新点亮红点。"
      />

      <div className="toolbar" style={{ marginTop: 0, marginBottom: 12 }}>
        <div className="seg">
          <button className={unreadOnly ? "" : "on"} onClick={() => setUnreadOnly(false)}>
            全部
          </button>
          <button className={unreadOnly ? "on" : ""} onClick={() => setUnreadOnly(true)}>
            未读{unreadCount > 0 ? ` ${unreadCount}` : ""}
          </button>
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部状态</SelectItem>
            {FEEDBACK_STATUSES.map((item) => (
              <SelectItem key={item} value={item}>
                {item}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部类型</SelectItem>
            {FEEDBACK_TYPES.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          className="w-48"
          placeholder="标题 / 正文关键字"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void loadList(0);
          }}
        />
        <Button size="sm" variant="default" className="gap-1.5" onClick={() => void loadList(0)}>
          <MagnifyingGlass size={14} /> 查询
        </Button>
        <div className="spacer" />
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void loadList(offset)}>
          <ArrowsClockwise size={14} /> 刷新
        </Button>
      </div>

      <div className="tablewrap">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>状态</TableHead>
              <TableHead>标题</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>严重度</TableHead>
              <TableHead>报告人 / 设备</TableHead>
              <TableHead>模块</TableHead>
              <TableHead>更新时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7}>
                  <SkeletonRows />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7}>
                  <div className="empty">
                    <ChatsCircle size={20} />
                    <div className="t">暂无反馈工单</div>
                    <div className="s">桌面端「问题上报」「给产品提需求」提交后会出现在这里</div>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((ticket) => (
                <TableRow
                  key={ticket.id}
                  className={selectedId === ticket.id ? "sel" : ""}
                  style={{ cursor: "pointer" }}
                  onClick={() => selectTicket(ticket.id)}
                >
                  <TableCell>
                    <ToneBadge tone={STATUS_TONE[ticket.status] ?? "neutral"} dot={ticket.unread}>
                      {ticket.status}
                    </ToneBadge>
                  </TableCell>
                  <TableCell>
                    <div className="cell-title">{ticket.title}</div>
                    <div className="cell-sub mono">{ticket.id.slice(0, 8)}</div>
                  </TableCell>
                  <TableCell>
                    <ToneBadge tone={TYPE_TONE[ticket.type] ?? "neutral"}>
                      {feedbackTypeLabel(ticket.type)}
                    </ToneBadge>
                  </TableCell>
                  <TableCell>
                    {ticket.severity ? (
                      <ToneBadge tone={SEVERITY_TONE[ticket.severity] ?? "neutral"}>
                        {ticket.severity}
                      </ToneBadge>
                    ) : (
                      <span className="cell-sub">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="cell-title">{ticket.reporter_display ?? "匿名用户"}</div>
                    <div className="cell-sub mono">{ticket.device_mid ?? "—"}</div>
                  </TableCell>
                  <TableCell>
                    <div className="cell-sub">{ticket.module ?? "—"}</div>
                  </TableCell>
                  <TableCell className="mono cell-sub">{fmtTime(ticket.updated_at)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="toolbar" style={{ marginTop: 12 }}>
        <span className="cell-sub">
          共 {total} 条 · 第 {total === 0 ? 0 : Math.floor(offset / PAGE_SIZE) + 1} /{" "}
          {Math.max(1, Math.ceil(total / PAGE_SIZE))} 页
        </span>
        <div className="spacer" />
        <Button
          size="sm"
          variant="outline"
          disabled={offset === 0 || loading}
          onClick={() => void loadList(Math.max(0, offset - PAGE_SIZE))}
        >
          上一页
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={loading || offset + PAGE_SIZE >= total}
          onClick={() => void loadList(offset + PAGE_SIZE)}
        >
          下一页
        </Button>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3>
            <ChatCenteredText size={16} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            工单详情
          </h3>
          <div className="sub">
            {detail
              ? `${detail.reporter_display ?? "匿名用户"} · ${fmtTime(detail.created_at)} 提交`
              : "在上方列表选择一条工单查看详情、流转状态并回复"}
          </div>
        </div>

        {!detail ? (
          <div className="empty">
            <ChatCenteredText size={20} />
            <div className="t">未选择工单</div>
          </div>
        ) : detailLoading && !detail.description ? (
          <SkeletonRows n={4} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
              <strong style={{ fontSize: 15 }}>{detail.title}</strong>
              <Select value={detail.status} onValueChange={(v) => void changeStatus(v)} disabled={updating}>
                <SelectTrigger className="w-32" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FEEDBACK_STATUSES.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={detail.severity ?? "none"}
                onValueChange={(v) => void changeSeverity(v === "none" ? "" : v)}
                disabled={updating}
              >
                <SelectTrigger className="w-32" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">未定严重度</SelectItem>
                  {FEEDBACK_SEVERITIES.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="cell-sub mono" style={{ marginLeft: "auto" }}>
                {detail.id}
              </span>
            </div>

            <div>
              <div className="cell-sub" style={{ marginBottom: 4 }}>
                问题描述
              </div>
              <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.7 }}>{detail.description}</div>
            </div>

            <div className="cell-sub mono">
              环境：{environmentLine(detail.environment)}
              {detail.contact ? ` · 联系方式：${detail.contact}` : ""}
              {detail.module ? ` · 模块：${detail.module}` : ""}
            </div>

            <div>
              <div className="cell-sub" style={{ marginBottom: 6 }}>
                消息往来（{detail.messages.length}）
              </div>
              {detail.messages.length === 0 ? (
                <div className="cell-sub">暂无补充消息</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {detail.messages.map((message) => (
                    <div
                      key={message.message_id}
                      style={{
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        padding: "8px 10px",
                        background: message.is_staff ? "var(--success-soft)" : "var(--surface-2)",
                      }}
                    >
                      <div className="cell-sub" style={{ marginBottom: 2 }}>
                        {message.is_staff ? "客服" : message.author_display_name ?? "用户"} ·{" "}
                        {fmtTime(message.created_at)}
                      </div>
                      <div style={{ whiteSpace: "pre-wrap" }}>{message.body}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="cell-sub" style={{ marginBottom: 6 }}>
                流转事件（{detail.events.length}）
              </div>
              {detail.events.length === 0 ? (
                <div className="cell-sub">暂无流转记录</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {detail.events.map((event) => (
                    <div key={event.id} className="cell-sub mono">
                      {fmtTime(event.created_at)} · {event.summary}
                      {event.actor_display_name ? ` · ${event.actor_display_name}` : ""}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="cell-sub" style={{ marginBottom: 6 }}>
                回复用户
              </div>
              <Textarea
                rows={3}
                value={reply}
                placeholder="回复内容会以「客服已回复」出现在用户客户端的工单详情里"
                onChange={(e) => setReply(e.target.value)}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
                <Button
                  size="sm"
                  variant="default"
                  className="gap-1.5"
                  disabled={sending || !reply.trim()}
                  onClick={() => void sendReply()}
                >
                  <PaperPlaneTilt size={14} /> {sending ? "发送中…" : "发送回复"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
