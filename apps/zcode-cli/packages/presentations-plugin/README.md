# presentations（演示文稿·内置插件）

面向 PPTX 的演示文稿制作技能，**随安装包内置**（SEA 资产 → 本地插件缓存），不经过
插件市场 CDN 下载；内网环境装完即可用。

## 为什么从市场插件改为仓库内置

部署环境为内外网隔离的公司内网：市场 seed 走 `cdn-zcode.z.ai`，断网时四件套会退化为
不可用。本插件与其余三个办公插件（documents / pdf / spreadsheets）一并 fork 进
`apps/zcode-cli/packages/*-plugin`，并登记进
`packages/cli/scripts/sea-official-plugin-assets.mjs` 的 `officialSeaPlugins` 清单。
边界与分层规则见 `docs/已完成/已完成-内网办公四件套-fork-spec.md`。

## 目录

```
.zcode-plugin/plugin.json        插件清单（version 0.1.8）
agents/visual-judge.md           渲染页视觉验收 Agent（只读，逐页 pass/fail 判决）
skills/pptx/
  SKILL.md                       824 行入口（场景 → 手法 → 脚本 → 依赖）
  scripts/                       上游 Fresh PPTX 借入的 10 个 Python 脚本（Apache-2.0，原样拷贝）
  LICENSE.txt                    Z.ai 专有许可：仅限个人、教育与非商业使用；产品方内部使用
```

## 已知短板与后续项

脚本库已于 0.1.8 借入补齐（dump_text / diagnose / render_pdf / render_slides /
contact_sheet / explode / assemble / insert_slide / prune，见 SKILL.md「Vendored
scripts」），deck 级的确定性操作不再需要现场写一次性脚本。**仍无模板库与配方约束**：
PPT 生成质量依然取决于模型现场发挥，没有 docx 那样的场景配方与 postcheck，补模板库
列为下一个增强项，见 `docs/已完成/已完成-内网办公四件套-fork-spec.md` 第 8 节。
