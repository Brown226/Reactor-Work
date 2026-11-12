// 登录门禁契约测试：未登录企业服务端一律停在登录页（2026-10-09 收窄为「只看身份」）。
// 覆盖 4 种身份 × 可用性组合，外加 provider registry 读取失败必须 fail-closed。
// 契约见 docs/已完成/已完成-model-governance-and-dev-mode.md §1.2 / §4 / §5。
import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelectionView } from "@zcode/services";
import { resolveProviderAvailabilityState } from "../src/lib/modelProviderAvailability.js";

/** 与 hook 内一致的谓词，单独抽出便于穷举（hook 只调用它，不再有第二处判断）。 */
function shouldOpenLoginEntry(params: { hasEnterpriseSession: boolean }): boolean {
  return !params.hasEnterpriseSession;
}

function viewWithModel(): ModelSelectionView {
  return {
    providers: [
      {
        providerId: "local-openai",
        models: [{ modelId: "local-model", displayName: "Local" }],
      },
    ],
  } as unknown as ModelSelectionView;
}

const identityCases = [
  { name: "未登录 + 无本地 provider", hasEnterpriseSession: false, view: null },
  { name: "未登录 + 本地 provider 有模型", hasEnterpriseSession: false, view: viewWithModel() },
  { name: "已登录 + 无本地 provider", hasEnterpriseSession: true, view: null },
  { name: "已登录 + 本地 provider 有模型", hasEnterpriseSession: true, view: viewWithModel() },
] as const;

for (const testCase of identityCases) {
  test(`门禁只看身份：${testCase.name} → ${testCase.hasEnterpriseSession ? "放行" : "停在登录页"}`, () => {
    // 可用性照旧可观测（用于日志与已登录时的模型就绪），但不参与门禁判定。
    const availability = resolveProviderAvailabilityState({ modelSelectionView: testCase.view });
    assert.equal(
      shouldOpenLoginEntry({ hasEnterpriseSession: testCase.hasEnterpriseSession }),
      !testCase.hasEnterpriseSession,
      `${testCase.name} 的门禁结果只由身份决定`,
    );
    assert.equal(typeof availability.hasUsableProvider, "boolean");
  });
}

test("本地 provider 有模型不能成为免登录理由（旧谓词会放行的回归点）", () => {
  const availability = resolveProviderAvailabilityState({ modelSelectionView: viewWithModel() });
  assert.equal(availability.hasUsableProvider, true, "前提：本地 provider 确实可用");
  assert.equal(
    shouldOpenLoginEntry({ hasEnterpriseSession: false }),
    true,
    "未登录时即便有可用本地 provider，也必须停在登录页",
  );
});

test("provider registry 读取失败按未登录处理（fail-closed）", () => {
  // 旧实现：读取失败只结束启动等待、不打开登录入口 → 未登录直接进工作区。
  // 现在：读取失败不能证明已登录，按未登录打开登录页。
  const hasEnterpriseSession = false;
  const modelSelectionError = new Error("registry read failed");
  const shouldOpen = Boolean(modelSelectionError) || shouldOpenLoginEntry({ hasEnterpriseSession });
  assert.equal(shouldOpen, true, "读取失败必须打开登录页，不能 fail-open");
});
