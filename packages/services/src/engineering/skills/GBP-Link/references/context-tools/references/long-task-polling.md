# 长耗时计算的等待与结果轮询模板

**适用**：一键计算类长耗时命令（`GpDlAutoDaylightCalc`、节能权衡计算、批量计算、碳排放一键计算 等）提交后，软件端进入长时计算。期间对 `galp_tool_invoke` 的任何调用可能返回 `MCPError: Failed to parse SSE message`（错误数据含 `OPERATION_...`，即软件端操作锁），或直接连接丢失。计算在软件端照常进行，**不要重新提交计算命令**，按以下模板轮询直至完成。

## 两条硬性护栏（违反将导致执行环境重置、连接丢失）

1. **单脚本预算 ≤ 240s**，且 python_executor 的 `timeout` 须 ≥ 预算 × 1.5（建议传 360）。脚本内累计 sleep 与调用耗时不得超过预算——曾因单脚本内 sleep 循环约 480s 触发 timeout 中断，执行环境被强制重置。
2. **分层轮询**：脚本内一轮（240s）未完成时打印 `POLL_INCOMPLETE` 并正常结束，由 Agent **再次执行同一段脚本**继续轮询（python_executor 命名空间会话内持久，连接保持）；累计约 20 轮仍未完成则如实告知用户计算未结束，建议人工检查软件端状态。

## 错误分类处理（禁止盲目 except 后一律重试）

| 情形 | 判据 | 处理 |
|---|---|---|
| 软件忙（计算中） | 异常含 `OPERATION_` 或 `parse SSE` | 按递增间隔等待后重试 |
| 连接失效 | 异常含 `closed` / `connect` | `connect_to_server("gbpmcp")` 重连一次后继续 |
| 返回内容畸形/截断 | `json.loads` 失败或字符串截断 | 保留原文片段打印，按一次失败重试；连续 3 次解析失败则停止轮询并人工辨识原文 |
| 业务错误 | 正常返回但 `code` 为 1001/1002/1004 | **立即停止轮询**：1002 须重查参数文档修正后重试，盲目重试无意义 |

## 轮询对象

有专用生成报告接口的模块（如采光的 `GpDlCreateReport`）轮询其生成报告接口；无生成报告接口的模块重试 `GetCurrentModule` 命令。

## 间隔策略

[10, 15, 20, 30, 45, 60] 秒递增，上限 60s——前期快速捕捉短计算，后期降低无效请求频率。

## 模板代码（用 python_executor 执行，按需替换其中的生成报告命令与参数）

```python
import time, json

def _call(cmd, params):
    try:
        raw = galp_tool_invoke(json.dumps({"command": cmd, "parameters": params}))
        if isinstance(raw, dict):
            return raw, None
        try:
            return json.loads(raw), None
        except Exception:
            return None, "PARSE:" + str(raw)[:200]
    except Exception as e:
        m = repr(e)
        if "OPERATION_" in m or "parse SSE" in m:
            return None, "BUSY:" + m[:150]
        if "closed" in m.lower() or "connect" in m.lower():
            return None, "CONN:" + m[:150]
        return None, "OTHER:" + m[:150]

intervals = [10, 15, 20, 30, 45, 60]   # 递增间隔，上限 60s
budget = time.time() + 240              # 单脚本预算 240s，timeout 建议传 360
n = 0
while time.time() < budget:
    n += 1
    res, err = _call("GetCurrentModule", {})   # 按需替换为对应模块的生成报告命令（如有）
    if err is None and res.get("code") == 1000:
        print(f"第{n}次查询成功")
        print(json.dumps(res, ensure_ascii=False)[:8000])
        break
    if err is None:
        print(f"业务错误 code={res.get('code')} | {res.get('msg')}，停止轮询")
        break
    kind = err.split(":", 1)[0]
    if kind == "OTHER":
        print("未知错误，停止轮询:", err[:300]); break
    if kind == "CONN":
        print("连接失效，重连后继续")
        try:
            connect_to_server("gbpmcp")
        except Exception as e:
            print("重连失败:", repr(e)[:150])
        time.sleep(10)
        continue
    wait = intervals[min(n - 1, len(intervals) - 1)]   # BUSY / PARSE
    print(f"第{n}次：{'软件忙(计算中)' if kind == 'BUSY' else '返回畸形'}，{wait}s 后重试")
    time.sleep(wait)
else:
    print("POLL_INCOMPLETE: 本轮预算(240s)内未完成，请再次运行本脚本继续轮询")
```
