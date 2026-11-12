import type { Hono } from "hono";
import { resolveUserSpaceConfig } from "./config.js";
import { spaceRoute } from "./errors.js";
import { resolveUserSpaceRoot } from "./paths.js";
import { readJsonObject, requireRequestUid, requireStringArrayField } from "./request.js";
import { listTrashItems, purgeTrashItems, restoreTrashItems } from "./trash.js";

/** 回收站路由（方案 §4）：列表、还原、彻底删除。空 ids 只在 purge 表示清空。 */
export function registerTrashRoutes(app: Hono): void {
  app.get(
    "/trash",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const config = resolveUserSpaceConfig();
      const root = resolveUserSpaceRoot(config.workspaceRoot, uid);
      return c.json({ items: await listTrashItems(root) });
    }),
  );

  app.post(
    "/trash/restore",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const config = resolveUserSpaceConfig();
      const body = await readJsonObject(c);
      const ids = requireStringArrayField(body, "ids", 1);
      const root = resolveUserSpaceRoot(config.workspaceRoot, uid);
      return c.json({ ok: true, restored: await restoreTrashItems(root, ids) });
    }),
  );

  app.post(
    "/trash/purge",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const config = resolveUserSpaceConfig();
      const body = await readJsonObject(c);
      // ids 必须显式给出：缺字段按 400 处理，避免「误传空 body 清空回收站」。
      const ids = requireStringArrayField(body, "ids", 0);
      const root = resolveUserSpaceRoot(config.workspaceRoot, uid);
      const result = await purgeTrashItems(root, ids);
      return c.json({ ok: true, purged: result.purged, freedBytes: result.freedBytes });
    }),
  );
}
