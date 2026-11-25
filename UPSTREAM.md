# 上游分叉治理

本文件记录本仓库与上游 `zai-org/ZCode` 的分叉状态、已决策事项和不可回退约束。

**结论先行：本仓库不整包合并上游版本。** 采用「维护分叉记录 + 按能力摘取」策略，变更此策略需明确说明理由。

---

## 1. 分叉与版本

| 项 | 值 |
| --- | --- |
| 本地合并基（分叉点） | `872ad960`（与当前 `upstream-zcode/main` **已无共同祖先**，`git merge-base` 为空，属 unrelated histories） |
| 上游最新（评估基线 2026-11-23） | `a4b44451`（v4.0.0，2026-11-23 发布）；本地 ref `upstream-zcode/main` 仅到 `fec97590`（v3.18.2，2026-11-13） |
| 本地版本 | `package.json` 3.18.0；基线提交 `1c289ad5`（基于上游 v3.18.0 `b95ebaff`） |
| 上游版本链 | `872ad960` → `29628c9a`(v3.14.3) → `aac47556`(v3.15.1) → `3c5b2276`(v3.16.2) → `a9fe401e`(v3.17.2) → `b95ebaff`(v3.18.0) → `c5904686`(v3.18.1) → `fec97590`(v3.18.2) → `a4b44451`(v4.0.0) |
| 落差规模 | v3.16.2 时 198 处冲突；v4.0.0 相对 v3.18.2 单提交 +149,753/−24,801 行、2,309 文件；本地相对 v3.18.0 有 3,216 个定制文件，其中 97 个与 v4.0.0 重叠 |
| 已摘取 | v3.18.1/v3.18.2/v4.0.0 的多项 P0/P1，详见 `docs/upstream/` 两份评估的「实施记录」节 |

上游每个版本是一个 `chore: sync ZCode source` squash 提交，单版本内常改 4000+ 文件，无法按 commit 逐条评估。

## 2. 拉取方式

仓库 remote 中没有 `upstream-zcode` 配置，必须显式 fetch：

```bash
git fetch https://github.com/zai-org/ZCode.git main:refs/remotes/upstream-zcode/main
```

GitHub 偶发连接超时，失败时先排查网络层，不要先怀疑凭据。

**开源仓库是内部仓库的快照同步，不是主开发仓。** 提交信息带 `Source-Commit: <内部提交>` 与 `Source-Sync: zcode-open-source-v1`，说明代码由内部主干定期导出。已观测时序：`3c5b2276`（2026-10-20）对应 v3.16.2 发布当天；v3.16.3（2026-10-23 发布）在本文档成稿时尚未出现在本地拉取的 main 中（2026-10-29）。

因此：**评估功能一律以本地已拉到的 commit 为准，不能以对外 release notes 为准。** release 先发、开源后补是正常现象，不代表功能被裁剪；但也可能滞后数天到数周，取决于上游同步节奏。

## 3. 不可回退约束（硬性）

以下五处是本地品牌化与数据落点的关键实现。未来任何来源的合并、覆盖、重写都不得使其回退。

| 文件 | 约束 |
| --- | --- |
| `packages/services/src/setting/settingService.ts` | 用户数据目录必须使用 `USER_DATA_DIR_NAME`，**禁止回退为 `.zcode`**。回退属于数据落点错误，运行期不报错、只表现为数据丢失 |
| `packages/web/src/main.tsx` | 4 处 `document.title` 必须为 `Reactor`，不得回退 `ZCode` |
| `packages/ui/src/ModelConfigSelect.tsx` | 单来源时平铺模型；`showManageModelsAction` 默认 `false`；保留 `shouldShowModelProviderLevel` 导出 |
| `packages/ui/src/lib/builtinSkillI18n.ts` | 品牌措辞为 Reactor；`scope === "server"` 显示「服务端」 |
| `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts` | 必须向 `createCredentialService` 注入 `safeStorage` 代理桥 |

## 4. 必须保持删除的上游模块

本地在做 Reactor 品牌化与自建登录/引导时主动删除了以下模块。上游仍在其上继续开发，**任何合并都会把这些文件放回工作树**，接受即破坏现有改造。

```
packages/services/src/onboarding/onboardingRecord.ts
packages/services/src/onboarding/onboardingRecordService.ts
packages/shared/src/onboardingRecord.ts
packages/ui/src/onboarding/OccupationOnboarding.tsx
packages/ui/src/onboarding/OnboardingDialog.tsx
packages/ui/src/onboarding/OnboardingDialogParts.tsx
packages/ui/src/onboarding/useOnboardingTrigger.ts
packages/ui/src/login/LoginApiKeyForm.tsx
packages/ui/src/login/LoginApiKeyForm.helpers.ts
packages/ui/src/WelcomeScreen.tsx
packages/ui/src/feedback/feedbackContactPreference.ts
packages/ui/src/hooks/useSettingsSync.ts
packages/ui/src/settings/SettingsSegmentedTabs.tsx
```

处理合并时，这些文件应显式保持删除，并检查是否有残留 import。

## 5. 已评估、决定不吸收的上游模块

| 模块 | 决策 | 理由 |
| --- | --- | --- |
| `project-sidebar` + `project-storage`（侧栏与项目 SQLite 持久化） | 不吸收 | 上游重写约 2400 行，本地侧栏改动仅 121 行；迁移成本高于收益 |
| 远程链路 v2（`source-server`、`web-remote-relay`） | 暂不吸收 | 仅在认真推进手机远控/多设备时重新评估 |
| `office-runtime` + 四件套 viewer | 暂不吸收（2026-10-29 已更正） | 上游是**完整的查看器运行时**（29 个 src + 36 个 ui：独立进程、CJK 字体运行时、离屏渲染、锚点、查找、多窗口状态隔离），不是骨架。本地四件套约 5 万行的主体是 docx/pdf/xlsx/pptx 的**生成技能与 agents**，与查看器不在同一层；本地自建的 PreviewPane office 预览仅 931 行。二者是互补关系而非替代关系。暂不引入的原因是接入成本（独立进程 + IPC + 中文字体体积 + 多窗口状态）高于当前收益，而非上游能力弱 |
| 上游测试补齐 | 不吸收 | 本地已有自建测试体系，引入不增加覆盖 |
| `off-peak-execution`（错峰执行） | 待验证 | 取决于是否存在真实排队/限流场景；内网模型无并发上限的情况下可能是空需求 |
| `sqlite-migrations`（表级备份/恢复） | 待核实 | 价值取决于 identity/server 现有备份机制，先核实再定 |
| 国内 `zai_cn` Start Plan 登录/可用性（v3.18.2 P1） | **内网不做**（2026-11-25 用户决策） | 依赖公网官方账号服务（Z.ai / BigModel Coding Plan），本仓已在 `未完成-REACTOR-REBRAND-PLAN.md` §5.1 下线官方服务入口，内网无适用场景 |
| 预装工具链（v4.0.0 P1，python/qpdf/pandoc/poppler/libreoffice） | **暂不做，范围缩至 Windows-only**（2026-11-25 用户决策） | 上游是**运行时从官方 CDN 下载**第三方软件运行时，制品不在仓库。用户确认只需 Windows 平台（2.07GB：LibreOffice 1.53GB、Python 274MB、pandoc 228MB、poppler 75MB、qpdf 12MB），其他平台不需要。但制品仍需从公网 CDN 获取后放入内网源，用户暂缓此项、待制品就绪再做 |

## 6. 重新评估的触发信号

出现以下任一情况时才重新评估合并，否则维持现状：

1. 上游出现本地需要、且无替代实现的能力。
2. 上游修复了本地正在踩的稳定性或安全问题。
3. 本地计划大改某模块，正好可借用上游重写省力。

## 7. 定期复查口径

每季度执行一次，只观察不合并：

```bash
git fetch https://github.com/zai-org/ZCode.git main:refs/remotes/upstream-zcode/main
git rev-list --left-right --count refs/remotes/upstream-zcode/main...HEAD
git merge-tree --write-tree HEAD refs/remotes/upstream-zcode/main | grep -c '^CONFLICT'
```

关注三点：冲突总数是否显著上升、是否出现新的基础模块替换、第 5 节中的决策前提是否改变。

## 8. 历史评估记录

- **2026-10-29 / v3.16.2**：198 处冲突（122 content + 56 add/add + 20 modify/delete），分类清单见 [`docs/上游合并评估-v3.16.2/冲突分类清单.md`](docs/上游合并评估-v3.16.2/冲突分类清单.md)。结论为不整包合并。
- **2026-10-29 / 判断更正**：原判「office-runtime 是骨架、本地 5 万行更强、替换为降级」**错误**。实测上游为完整查看器运行时，本地为生成技能 + 931 行内嵌预览，两者分层互补。决策改为「暂不吸收」但理由换成接入成本，并把该项从「不吸收」划入「待评估」。
- **2026-10-29 / 发布节奏核实**：3.16.2 发布当天（10-20）开源已同步；3.16.3（10-23）截至成稿未同步到本地 main。开源仓为内部仓快照导出，非实时。
- **2026-11-20 / v3.18.1–v3.18.2**：两版合计 148 文件、26 个与本地定制重叠；结论仍为不整包合并、按能力摘取。第一批 4 项（Windows 安装器进程收口、PowerShell Authenticode、流式摘要/reasoning、交互来源徽标）已落地。评估见 [`docs/upstream/上游更新评估-v3.18.1-v3.18.2.md`](docs/upstream/上游更新评估-v3.18.1-v3.18.2.md)。
- **2026-11-23 / v4.0.0**：上游最新 `a4b44451`，12 项新增能力、97 个文件与本地定制重叠。P0 五项（UI 三小修、插件首帧主题、会话退出确认、崩溃重启、导航边界）**已全部提交落地**（`fe77da8e`/`313eba06`/`cebc65dc`/`fdc55b0d`/`6904b90f`）；P1 六项待排期（预装工具链、项目目录插件信任、Agent 回复语言、草稿模型迁移、Skill 实时目录、iOS 项目发现）。评估见 [`docs/upstream/上游更新评估-v4.0.0.md`](docs/upstream/上游更新评估-v4.0.0.md)。
- **2026-11-24 / 同步口径核对**：本地 `main` 领先 `origin/main` 9 个提交未 push；`git fetch` 受网络限制（SSL/TLS 握手失败）未执行，无法确认 11-23 后是否有更新版本。
- **2026-11-25 / 内网口径收敛**：用户确认本仓为纯内网部署。**移除一项**依赖官方服务的待摘能力——v3.18.2 P1 国内 `zai_cn` Start Plan（官方入口已下线）。**v4.0.0 P1 预装工具链保留**：用户明确该项与 file-tools assets 同构，采用**有网环境提前封装工具制品进发行包**的方式交付，内网侧不访问公网；摘取时把上游的运行时下载/签名改造为构建期预置 + 随包分发。待摘 P1 由 9 项降为 8 项、P2 4 项不变；P0 十项全部完成。其余待摘项均为本地能力，内网可用。
