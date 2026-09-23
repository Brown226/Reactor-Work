# review-skills（审查技能·内置插件）

文件审查板块的 5 个技能，**随安装包内置**，不经企业服务端下发。用户装完即可在审查档的
快捷按钮里用到，离线（内网无公网）环境下同样可用。

## 为什么是内置插件而不是服务端技能

- 审查技能是**产品能力**，不是组织数据：所有用户拿到的判定规则、输出格式、错词表都应一致，
  不该依赖「管理员先导入一次」这个前置动作。
- 服务端技能库留给**企业自建技能**（组织内部规范、部门模板），两者互不冲突：同名时
  workspace > server > plugin > user（见 `packages/ui/src/mentions/providers/skillsMentionProvider.ts`）。

## 目录

```
.zcode-plugin/plugin.json        插件清单（skills: "skills"）
skills/review-proofread/         基础校对（含 references/typo-dictionary.md 218 组错词、punctuation-rules.md）
skills/review-consistency/       全文一致性
skills/review-compare/           以文审文
skills/review-contract/          合同风险审查
skills/review-standard-check/    标准引用自检（强制走 KnowledgeCheck 确定性比对）
```

## 数据边界

技能只固化**判定规则与输出格式**。需要真值的地方一律走端侧数据：

- 标准编号/名称/状态 → `KnowledgeCheck`（`action=standards`），读 `~/.reactor/knowledge/standards.json`；
- 术语白名单 → `KnowledgeCheck`（`action=terminology`）；规范库 → `action=rules`。

这三份缓存的来源是管理台（企业服务端），技能自身不联网、也不内置标准数据。

## 绑定关系

审查档输入框下方的快捷按钮与技能一一对应（见 `packages/ui/src/v4/reviewQuickActionPrompts.ts`），
按钮预填的正文里带 `$<skill-name>` 技能引用。
