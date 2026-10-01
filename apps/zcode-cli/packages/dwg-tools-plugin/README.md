# @zcode/dwg-tools-plugin

官方内置插件 `dwg-tools`：DWG 图纸解析/修改（`dwg_modify`）与符号拓扑（`dwg_graph`）。
引擎为 ACadSharp .NET sidecar（自包含发布，~35MB）。见 `docs/未完成-file-tools拆三插件方案.md`。

```bash
# 发布 sidecar（需 .NET SDK；部分环境 NuGet restore 可能失败，prepare 脚本会回退历史产物）
node scripts/publish-sidecar.mjs --rid win-x64 --required
pnpm --filter @zcode/dwg-tools-plugin build
pnpm --filter @zcode/dwg-tools-plugin typecheck
pnpm --dir apps/zcode-cli/packages/dwg-tools-plugin exec tsx --test "test/*.test.ts"

# MCP stdio 冒烟（spawn dist server；须在插件目录下执行，脚本按 cwd 解析 dist/mcp/server.js）
# 断言 tools/list 只含 dwg_modify / dwg_graph（出现 file-tools / ocr-tools 的工具即失败），
# 并对 fixture 图纸跑 dwg_modify 读模式 + dwg_graph；省略参数时用仓库 fixture。
# 未发布 sidecar 时按 SMOKE-SKIP 显式跳过工具调用并打印原因，退出码 2（不算通过）。
# 退出码：0 通过；1 失败；2 有跳过的调用。
cd apps/zcode-cli/packages/dwg-tools-plugin
node scripts/smoke-stdio.mjs [drawing.dwg]
```

## 资产与分发

- sidecar 由 `node ../../../../scripts/prepare-file-tools-assets.mjs`（仓库根 `scripts/`）发布：
  - 打包态 → `packages/desktop/bundled-tools/<platformKey>/dwg-tools/dwg-sidecar/<rid>/`
    → electron-builder extraResources `resources/tools/dwg-tools`；
  - 开发/seed 态 → 本包 `assets/<platformKey>/dwg-sidecar/<rid>/`（definition.runtimeTopLevelPaths: ["assets"]）。
- 这份 assets 树必须非空：`bundled-plugins.hasDeclaredAssetsButNoFiles` 会把「声明了 assets 却收不到
  文件」的插件整体拒绝 seed，症状是 `dwg_modify` / `dwg_graph` 在任何安装形态下都不可达。
- 运行时解析链（env → resourcesPath/tools/dwg-tools → 包内 assets → dist/dwg-sidecar）见 `src/assets.ts`。

## 已知约束

- `dwg_graph` 只认块引用（INSERT）符号、只收 LINE/多段线（圆弧不收）、tag 只取模型空间
  文本（块属性 ATTRIB 位号不取）；符号为散落图元绘制的图纸返回空图并在 `note` 明示。
- DWG 上限 50MB、文本实体上限 5000 条（可调）。
- ACadSharp 与 .NET runtime 均为 MIT；THIRD-PARTY-NOTICES.txt 随 sidecar 资产目录分发。
