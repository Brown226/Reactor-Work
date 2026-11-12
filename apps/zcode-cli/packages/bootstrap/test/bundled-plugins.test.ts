/**
 * 官方插件 seed 的「资产不完整」兜底回归（`npx tsx --test packages/bootstrap/test/bundled-plugins.test.ts`）。
 *
 * 钉住的是一次线上事故的口径：file-tools 的源资产在 build 期被「先清空再拷贝」，
 * seed 恰好在窗口期跑了一次，marker 写成完整（requiredSeedPaths 只查 dist 文件），
 * 于是缓存「seed 成功但 anydoc/canvas/onnxruntime 全缺」，运行时报
 * 「未找到 anydoc 原生资产」，且因为没人再发现源变了，重启也不自愈。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { hasDeclaredAssetsButNoFiles } from "../src/app/bundled-plugins.js";

const ASSET_PATHS = [
  "assets/win32-x64/anydoc/node_modules/@firecrawl/anydoc/package.json",
  "assets/win32-x64/canvas/node_modules/@napi-rs/canvas/package.json",
  "assets/win32-x64/ocr-models/PP-OCRv5_mobile_det_infer.onnx",
];

test("seed 守卫：声明 assets 却一个资产文件都没收上来 → 判残缺", () => {
  assert.equal(hasDeclaredAssetsButNoFiles({ runtimeTopLevelPaths: ["assets"] }, []), true);
  assert.equal(
    hasDeclaredAssetsButNoFiles({ runtimeTopLevelPaths: ["assets"] }, [
      { path: "dist/mcp/server.js" },
      { path: "package.json" },
    ]),
    true,
    "dist 齐了但资产为空也算残缺（这正是事故形态）",
  );
  assert.equal(
    hasDeclaredAssetsButNoFiles({ runtimeTopLevelPaths: ["assets"] }, [
      { path: "dist/mcp/server.js" },
      { path: ASSET_PATHS[0]! },
    ]),
    false,
  );
});

test("seed 守卫：不声明 runtime 资产的插件不受影响", () => {
  assert.equal(hasDeclaredAssetsButNoFiles({ runtimeTopLevelPaths: [] }, []), false);
  assert.equal(hasDeclaredAssetsButNoFiles({}, []), false);
  assert.equal(
    hasDeclaredAssetsButNoFiles({ runtimeTopLevelPaths: ["dist"] }, [{ path: "dist/mcp/server.js" }]),
    false,
  );
});
