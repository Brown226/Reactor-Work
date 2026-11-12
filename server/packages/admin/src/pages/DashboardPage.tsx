/**
 * 运营总览（**BuildingAI 看板版式移植**，管理端移植第 1 批）。
 *
 * 主体是**整棵搬来**的上游 dashboard（`kb-port/pages/console/dashboard`）——
 * 统计卡 / 面积图 / Token 排行（模型·供应商 Tabs）都是上游原样；取数层由
 * `kb-shims/console-services.tsx` 的 dashboard 段接到本仓
 * `/desktop/usage/summary` 与 `usersApi`。
 *
 * ## 区块口径（2026-09-19 与用户对齐后的终态）
 *
 *  - **「客户端使用」卡**（替换上游「订单统计」，脚本变换 `CLIENT_USAGE_CARD`）：
 *    今日/近7日有模型调用的去重用户数 + 活跃较昨日 ±%——服务端无心跳，「严格在线」不可得。
 *  - **「收入趋势」「用户趋势（访问/注册）」图与「应用使用排行」**：本仓无数据源（ToC 概念 /
 *    会话不出端 / 技能使用量管理端聚合未做）→ 空图或空态。section 对象仍恒在场
 *    （页面只做一层可选链，缺席即白屏——见 toDashboardData 头注与 t194 的钉子）。
 *  - 早期的「移植说明」横幅与「平台现状」折叠区已按用户要求**移除**
 *   （内容有底：git 历史 2fb964b 之前的 DashboardPage + 本台账 §2.1）。
 *
 * ## 原 Overview 的内容去哪了
 *
 * 组织规模指标与「已上线/路线」清单随横幅一并移除（用户拍板）；
 * 历史版本见 git（2fb964b）与 [管理端BuildingAI移植-台账-v1.md](../../docs/实施计划/管理端BuildingAI移植-台账-v1.md)。
 */
import DashboardIndexPage from "../kb-port/pages/console/dashboard";
import { useAuthStore } from "../stores/auth";
import { PageHead } from "../ui";

export default function DashboardPage(): React.ReactElement {
  const scope = useAuthStore((s) => s.scope);

  return (
    <div>
      <PageHead
        title="运营总览"
        desc="用量与活跃的真实数据面；看板版式移植自 BuildingAI（管理端移植第 1 批）。"
        /* 数据范围徒标（枚举）：只表达「你能看到多少数据」，不表达权限角色。
           平台全量是默认态 ⇒ `all`，不渲染徒标（原实现会显示「范围：全公司」，是纯噪音）。
           ⚠ Scope 的第三态是 `self`（不是 `user`）—— 类型定义见 types.ts */
        scope={scope?.kind === "dept" ? "dept" : scope?.kind === "self" ? "self" : "all"}
      />
      <DashboardIndexPage />
    </div>
  );
}
