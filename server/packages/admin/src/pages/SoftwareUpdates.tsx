// 系统 · 软件更新（UPD）
//
// 为什么这个页面存在：桌面端自更新走的是**服务端 manifest**（客户端路径写死
// /api/v1/releases/electron/manifest，打包后连 URL 覆盖都会被忽略），
// 因此"发一个新版本"这件事必须能在管理台完成：登记版本 → 上传安装包 → 上线。
//
// 与其它页面的两点不同：
//  1. 产物是几百 MB 的二进制，走 http.uploadRaw（原始字节 + 进度），不是 JSON 表单；
//  2. "上传"与"上线"是两步 —— 草稿态可以反复换产物，一旦上线就不能再改文件
//     （客户端缓存按 sha512 判定，换文件会让已下载用户校验失败）。
//
// 灰度（rolloutPercent）按 device_mid 稳定分桶，只影响新请求该版本的设备；已下载的下载照旧。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowCircleUp, CloudArrowUp, Plus, Trash } from "@phosphor-icons/react";
import { toast } from "../lib/toast";
import { PageHead, SkeletonRows } from "../ui";
import { ToneBadge } from "../components/reactor";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";
import {
  RELEASE_ARTIFACT_SUFFIXES,
  RELEASE_CHANNELS,
  RELEASE_PLATFORMS,
  formatBytes,
  releaseChannelLabel,
  updatesApi,
  type AdminRelease,
  type ReleaseChannel,
} from "../services/updates";

const ALL = "__all__";
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;

interface DraftForm {
  platform: string;
  channel: ReleaseChannel;
  version: string;
  releaseName: string;
  releaseNotesZh: string;
  releaseNotesEn: string;
  rolloutPercent: number;
  publishNow: boolean;
  file: File | null;
}

const emptyDraft = (): DraftForm => ({
  platform: RELEASE_PLATFORMS[0],
  channel: "stable",
  version: "",
  releaseName: "",
  releaseNotesZh: "",
  releaseNotesEn: "",
  rolloutPercent: 100,
  publishNow: true,
  file: null,
});

function isAllowedArtifact(name: string): boolean {
  const lower = name.toLowerCase();
  return RELEASE_ARTIFACT_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function SoftwareUpdates() {
  const [rows, setRows] = useState<AdminRelease[] | null>(null);
  const [total, setTotal] = useState(0);
  const [platformFilter, setPlatformFilter] = useState<string>(ALL);
  const [channelFilter, setChannelFilter] = useState<string>(ALL);
  const [draft, setDraft] = useState<DraftForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  /** 目标记录：新建发布时为 null（草稿在提交时才建），单独上传产物时为该行 */
  const [uploadTarget, setUploadTarget] = useState<AdminRelease | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    const result = await updatesApi.list({
      ...(platformFilter === ALL ? {} : { platform: platformFilter }),
      ...(channelFilter === ALL ? {} : { channel: channelFilter }),
      limit: 100,
    });
    setRows(result.releases);
    setTotal(result.total);
  }, [platformFilter, channelFilter]);

  useEffect(() => {
    void load().catch((error) => toast.error((error as Error).message));
  }, [load]);

  const manifestHint = useMemo(
    () => `${window.location.origin}/api/v1/releases/electron/manifest?platform=<平台>&channel=<1|3>`,
    [],
  );

  const pickFile = (file: File | null, target: "draft" | "upload") => {
    if (!file) return;
    if (!isAllowedArtifact(file.name)) {
      toast.error(`产物类型不支持，需为 ${RELEASE_ARTIFACT_SUFFIXES.join(" / ")}`);
      return;
    }
    if (file.size > MAX_ARTIFACT_BYTES) {
      toast.error(`产物超过 1GB 上限（服务端 REACTOR_UPDATE_MAX_BYTES 可调）`);
      return;
    }
    if (target === "draft") {
      setDraft((current) => (current ? { ...current, file } : current));
    } else {
      void uploadArtifact(file);
    }
  };

  const submitDraft = async () => {
    if (!draft) return;
    if (!draft.version.trim()) {
      toast.error("请填写版本号");
      return;
    }
    if (!/^\d+\.\d+\.\d+/.test(draft.version.trim())) {
      toast.error("版本号请用语义化写法，如 1.2.3");
      return;
    }
    if (!draft.file) {
      toast.error("请选择安装包产物");
      return;
    }

    setBusy(true);
    setProgress(0);
    try {
      const created = await updatesApi.create({
        platform: draft.platform,
        channel: draft.channel,
        version: draft.version.trim(),
        ...(draft.releaseName.trim() ? { releaseName: draft.releaseName.trim() } : {}),
        ...(draft.releaseNotesZh.trim() ? { releaseNotesZh: draft.releaseNotesZh } : {}),
        ...(draft.releaseNotesEn.trim() ? { releaseNotesEn: draft.releaseNotesEn } : {}),
        rolloutPercent: draft.rolloutPercent,
      });
      await updatesApi.uploadArtifact(created.release.id, draft.file, {
        onProgress: ({ loaded, total: size }) => {
          setProgress(size > 0 ? Math.round((loaded / size) * 100) : null);
        },
      });
      if (draft.publishNow) {
        await updatesApi.patch(created.release.id, { published: true });
      }
      toast.ok(
        draft.publishNow
          ? `v${created.release.version} 已上线（${releaseChannelLabel(created.release.channel)}通道）`
          : `v${created.release.version} 已存为草稿`,
      );
      setDraft(null);
      await load();
    } catch (error) {
      // 草稿可能已经建好（失败在上传）：提示里说清楚，避免管理员重复建导致 409。
      toast.error(`${(error as Error).message}（若已生成草稿，可在列表里继续上传产物）`);
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const uploadArtifact = async (file: File) => {
    const target = uploadTarget;
    if (!target) return;
    setBusy(true);
    setProgress(0);
    try {
      await updatesApi.uploadArtifact(target.id, file, {
        onProgress: ({ loaded, total: size }) => {
          setProgress(size > 0 ? Math.round((loaded / size) * 100) : null);
        },
      });
      toast.ok(`产物已上传：${file.name}`);
      setUploadTarget(null);
      await load();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const togglePublish = async (row: AdminRelease) => {
    try {
      await updatesApi.patch(row.id, { published: !row.published });
      toast.ok(row.published ? `v${row.version} 已下线` : `v${row.version} 已上线`);
      await load();
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const remove = async (row: AdminRelease) => {
    if (!window.confirm(`删除 v${row.version}（${row.platform} / ${releaseChannelLabel(row.channel)}）？产物文件会一并删除。`)) {
      return;
    }
    try {
      await updatesApi.remove(row.id);
      toast.ok(`已删除 v${row.version}`);
      await load();
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  return (
    <div>
      <PageHead
        title="软件更新"
        desc="登记桌面端版本、上传安装包并控制下发；客户端按平台与通道取「已上线里最新的一条」"
      />

      <div className="toolbar" style={{ marginTop: 0, marginBottom: 12 }}>
        <ToneBadge tone="info">客户端 manifest 地址：{manifestHint}</ToneBadge>
        <div className="spacer" />
        <Select value={platformFilter} onValueChange={setPlatformFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部平台</SelectItem>
            {RELEASE_PLATFORMS.map((platform) => (
              <SelectItem key={platform} value={platform}>
                {platform}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={channelFilter} onValueChange={setChannelFilter}>
          <SelectTrigger className="w-[130px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部通道</SelectItem>
            {RELEASE_CHANNELS.map((channel) => (
              <SelectItem key={channel} value={channel}>
                {releaseChannelLabel(channel)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="default"
          className="gap-1.5"
          onClick={() => {
            setDraft(emptyDraft());
          }}
        >
          <Plus size={14} /> 新建发布
        </Button>
      </div>

      <div className="tablewrap">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>版本</TableHead>
              <TableHead>平台 / 通道</TableHead>
              <TableHead>产物</TableHead>
              <TableHead>灰度</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>上线时间</TableHead>
              <TableHead className="w-[200px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows === null ? (
              <TableRow>
                <TableCell colSpan={7}>
                  <SkeletonRows />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7}>
                  <div className="empty">
                    <CloudArrowUp size={22} />
                    <div className="t">还没有发布记录</div>
                    <div className="s">新建发布并上传安装包后，客户端才能检查到更新</div>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <div style={{ fontWeight: 600 }}>v{row.version}</div>
                    <div className="cell-sub">{row.releaseName || "—"}</div>
                  </TableCell>
                  <TableCell>
                    <div className="mono">{row.platform}</div>
                    <div className="cell-sub">{releaseChannelLabel(row.channel)}通道</div>
                  </TableCell>
                  <TableCell>
                    {row.hasArtifact ? (
                      <>
                        <div className="mono" style={{ wordBreak: "break-all" }}>
                          {row.fileName}
                        </div>
                        <div className="cell-sub">{formatBytes(row.sizeBytes)}</div>
                      </>
                    ) : (
                      <ToneBadge tone="warn">缺少产物</ToneBadge>
                    )}
                  </TableCell>
                  <TableCell>{row.rolloutPercent >= 100 ? "全量" : `${row.rolloutPercent}%`}</TableCell>
                  <TableCell>
                    {row.published ? (
                      <ToneBadge tone="success">已上线</ToneBadge>
                    ) : (
                      <ToneBadge tone="neutral">草稿</ToneBadge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div>{formatTime(row.publishedAt)}</div>
                    {row.publishedBy ? <div className="cell-sub">{row.publishedBy}</div> : null}
                  </TableCell>
                  <TableCell>
                    <div className="row-actions">
                      {row.hasArtifact ? null : (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="gap-1"
                          onClick={() => {
                            setUploadTarget(row);
                            uploadInputRef.current?.click();
                          }}
                        >
                          <CloudArrowUp size={14} /> 上传产物
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1"
                        disabled={!row.hasArtifact}
                        onClick={() => void togglePublish(row)}
                      >
                        <ArrowCircleUp size={14} /> {row.published ? "下线" : "上线"}
                      </Button>
                      <Button size="sm" variant="ghost" className="gap-1" onClick={() => void remove(row)}>
                        <Trash size={14} />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {total > (rows?.length ?? 0) ? (
        <div className="cell-sub" style={{ marginTop: 8 }}>
          共 {total} 条，仅显示最新 {rows?.length ?? 0} 条
        </div>
      ) : null}

      {/* 新建发布：元数据 + 产物 + 是否直接上线 */}
      <Dialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDraft(null);
        }}
      >
        <DialogContent className="modal">
          <DialogHeader className="modal-head">
            <DialogTitle>新建发布</DialogTitle>
          </DialogHeader>
          <div className="modal-body" style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <Label>平台</Label>
                <Select
                  value={draft?.platform}
                  onValueChange={(value) => setDraft((current) => (current ? { ...current, platform: value } : current))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RELEASE_PLATFORMS.map((platform) => (
                      <SelectItem key={platform} value={platform}>
                        {platform}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>通道</Label>
                <Select
                  value={draft?.channel}
                  onValueChange={(value) =>
                    setDraft((current) => (current ? { ...current, channel: value as ReleaseChannel } : current))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RELEASE_CHANNELS.map((channel) => (
                      <SelectItem key={channel} value={channel}>
                        {releaseChannelLabel(channel)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
              <div>
                <Label>版本号</Label>
                <Input
                  placeholder="1.2.3"
                  value={draft?.version ?? ""}
                  onChange={(event) => setDraft((current) => (current ? { ...current, version: event.target.value } : current))}
                />
              </div>
              <div>
                <Label>发布名（可空，默认 Reactor &lt;版本&gt;）</Label>
                <Input
                  placeholder="Reactor 1.2.3"
                  value={draft?.releaseName ?? ""}
                  onChange={(event) =>
                    setDraft((current) => (current ? { ...current, releaseName: event.target.value } : current))
                  }
                />
              </div>
            </div>

            <div>
              <Label>更新说明（中文，Markdown）</Label>
              <Textarea
                rows={3}
                placeholder={"- 修复……\n- 优化……"}
                value={draft?.releaseNotesZh ?? ""}
                onChange={(event) =>
                  setDraft((current) => (current ? { ...current, releaseNotesZh: event.target.value } : current))
                }
              />
            </div>
            <div>
              <Label>更新说明（英文，可空）</Label>
              <Textarea
                rows={2}
                value={draft?.releaseNotesEn ?? ""}
                onChange={(event) =>
                  setDraft((current) => (current ? { ...current, releaseNotesEn: event.target.value } : current))
                }
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "end" }}>
              <div>
                <Label>灰度比例（%，100 为全量）</Label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={String(draft?.rolloutPercent ?? 100)}
                  onChange={(event) =>
                    setDraft((current) =>
                      current ? { ...current, rolloutPercent: Number(event.target.value) || 100 } : current,
                    )
                  }
                />
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Switch
                  checked={draft?.publishNow ?? true}
                  onCheckedChange={(checked) =>
                    setDraft((current) => (current ? { ...current, publishNow: checked === true } : current))
                  }
                />
                <span>上传完成后直接上线</span>
              </label>
            </div>

            <div>
              <Label>安装包</Label>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Button size="sm" variant="ghost" className="gap-1" onClick={() => fileInputRef.current?.click()}>
                  <CloudArrowUp size={14} /> 选择文件
                </Button>
                <span className="cell-sub">
                  {draft?.file ? `${draft.file.name}（${formatBytes(draft.file.size)}）` : RELEASE_ARTIFACT_SUFFIXES.join(" / ")}
                </span>
              </div>
            </div>

            {progress !== null ? (
              <div>
                <div className="cell-sub">上传中 {progress}%</div>
                <div style={{ height: 6, borderRadius: 3, background: "var(--surface-2)", marginTop: 4 }}>
                  <div
                    style={{
                      height: 6,
                      borderRadius: 3,
                      width: `${progress}%`,
                      background: "var(--accent)",
                      transition: "width .2s ease",
                    }}
                  />
                </div>
              </div>
            ) : null}
          </div>
          <DialogFooter className="modal-foot">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
              取消
            </Button>
            <Button size="sm" variant="default" disabled={busy} onClick={() => void submitDraft()}>
              {busy ? "处理中…" : "创建并上传"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 隐藏的文件选择器：草稿用与"上传产物"共用一套校验 */}
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: "none" }}
        onChange={(event) => {
          pickFile(event.target.files?.[0] ?? null, "draft");
          event.target.value = "";
        }}
      />
      <input
        ref={uploadInputRef}
        type="file"
        style={{ display: "none" }}
        onChange={(event) => {
          pickFile(event.target.files?.[0] ?? null, "upload");
          event.target.value = "";
        }}
      />
    </div>
  );
}
