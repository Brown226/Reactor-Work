# 启动可观测：事件循环 lag — spec v1

## 背景与现状核验（重要）

来源：Namiwork 的「启动时间线 + 事件循环 lag」可观测能力。**核验后必须区分两部分**：

- **启动时间线：Reactor 已有，不重复造。**
  `packages/shared/src/launchMarks.ts`（T0 进程创建 / T1 main JS / T2 whenReady / T3 loadURL）
  + `packages/ui/src/lib/launchToInputReport.ts`（renderer 启动 / React commit / 输入就绪）
  + `packages/ui/src/lib/uiPerfArmsTelemetry.ts`（`perf_ui_launch_*` 分阶段上报）。
- **事件循环 lag：Reactor 缺口。** 全仓无 `perf_hooks.monitorEventLoopDelay` 命中。

所以本项只补"事件循环 lag"，不动既有时间线。

## 产品规则

1. main 进程用一个低频采样器周期读取事件循环延迟直方图，产出 p50 / p99 / max（ms）。
2. 每 60 秒汇总一次并写入结构化日志（`logger.info`）；p99 超过阈值（100ms）时用
   `logger.warn`，方便内网排障时按级别筛选。
3. 每次汇总后重置直方图，保证统计的是**本周期**而非进程启动至今的累计值。
4. 采样间隔定时器 `unref()`，不阻止进程退出；`will-quit` 时停止并禁用直方图。
5. 纯观测：任何失败只记 warn，不影响主流程（与既有 ARMS 上报的容错口径一致）。

## 状态所有者

- 模块级单例（histogram + timer），唯一读写在 `desktopEventLoopLagMonitor`；
  main 只在 `app.whenReady` 后 start、`will-quit` 时 stop。
- 不新增 IPC 通道、不进 renderer、不改设置。

## 验收场景

- [ ] main 启动后每 60s 输出一条 `[event-loop-lag]` 日志，含 p50/p99/max。
- [ ] 一次长阻塞（>100ms）后，下个周期的 p99 升高并按 warn 输出。
- [ ] 每个周期重置，不会因进程长期运行把 p50 越拉越低。
- [ ] 应用退出时定时器被清理，不残留。

## 验证口径

行为改动（main）→ 全量 `pnpm typecheck` + `pnpm lint`，并对 main 单独跑
`tsc -b packages/desktop/tsconfig.main.json`（根 typecheck 只覆盖 host）。
运行期日志需真实运行应用才能观察，本项以编译 + lint 通过为准，如实注明。
