# 上游分叉治理

本文件记录本仓库与上游 `zai-org/ZCode` 的分叉状态、已决策事项和不可回退约束。

**结论先行：本仓库不整包合并上游版本。** 采用「维护分叉记录 + 按能力摘取」策略，变更此策略需明确说明理由。

---

## 1. 分叉与版本

| 项 | 值 |
| --- | --- |
| 本地合并基（分叉点） | `872ad960` |
| 上游最新（2026-10-29 拉取） | `3c5b2276`（v3.16.2） |
| 本地领先 / 落后 | 152 / 4（`git rev-list --left-right --count`） |
| 上游版本链 | `872ad960` → `29628c9a`(v3.14.3) → `aac47556`(v3.15.1) → `3c5b2276`(v3.16.2) |
| 完整落差规模 | 4 个 squash，约 1.6 万文件变更 |

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
