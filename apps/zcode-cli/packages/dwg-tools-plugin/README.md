# @zcode/dwg-tools-plugin

官方内置插件 `dwg-tools`：DWG 图纸解析/修改（`dwg_modify`）与符号拓扑（`dwg_graph`）。
引擎为 ACadSharp .NET sidecar（自包含发布，~35MB）。见 `docs/未完成-file-tools拆三插件方案.md`。

```bash
# 发布 sidecar（需 .NET SDK；部分环境 NuGet restore 可能失败，prepare 脚本会回退历史产物）
node scripts/publish-sidecar.mjs --rid win-x64 --required
pnpm --filter @zcode/dwg-tools-plugin build
pnpm --filter @zcode/dwg-tools-plugin typecheck
```
