/**
 * 软件更新数据域（UPD）：Electron 桌面端自更新的产物登记表。
 *
 * 为什么单独一张表、而不像技能那样把内容放进 PG：
 * 安装包是几百 MB 量级的大文件，字节只能落磁盘卷，表里只留**寻址 + 校验和 + 发布状态**。
 * 磁盘文件名与管理员看到的原始文件名分开存（`stored_name` 是 uuid + 扩展名），
 * 这样原始文件名的特殊字符/中文只出现在 UI 与 Content-Disposition，不参与路径拼接。
 *
 * 客户端只按 (platform, channel) 取「已发布里 published_at 最新的一条」，
 * 因此索引按这个查询建；UNIQUE(platform, channel, version) 拦掉同一通道的重复登记，
 * 让"传一半断电重来"变成 409 而不是两条半成品记录。
 */
import type { IdentityDb } from "../identity/db.js";

export async function ensureUpdatesSchema(db: IdentityDb): Promise<void> {
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS app_release (
      id SERIAL PRIMARY KEY,
      -- 客户端传的是 electron 平台串：windows-x64 / darwin-arm64 / linux-x64
      platform TEXT NOT NULL,
      -- stable / preview，对应客户端 receivePreviewUpdates 设置
      channel TEXT NOT NULL,
      -- 语义化版本，客户端只做字符串比较之外的排序由 published_at 决定
      version TEXT NOT NULL,
      release_name TEXT,
      release_notes_zh TEXT,
      release_notes_en TEXT,
      -- 灰度比例（0-100）：客户端带 device_mid，按哈希分桶决定是否下发
      rollout_percent INTEGER NOT NULL DEFAULT 100,
      published BOOLEAN NOT NULL DEFAULT false,
      published_at TIMESTAMPTZ,
      published_by TEXT,
      -- 产物：原始文件名给 UI/下载头，stored_name 给磁盘，sha512 用 base64（electron-updater 口径）
      file_name TEXT,
      stored_name TEXT,
      size_bytes BIGINT,
      sha512_base64 TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (platform, channel, version)
    );
  `);
  await db.pool.query(`
    CREATE INDEX IF NOT EXISTS idx_app_release_lookup
      ON app_release (platform, channel, published, published_at DESC);
  `);
  // 后续加字段照着 audit/schema.ts 的做法续写幂等补列：
  //   ALTER TABLE app_release ADD COLUMN IF NOT EXISTS <col> <type>;
}
