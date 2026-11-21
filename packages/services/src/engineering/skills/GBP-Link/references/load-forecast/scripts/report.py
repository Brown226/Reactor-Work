# -*- coding: utf-8 -*-
"""结果统计与绘图：峰谷均值、月度汇总表、逐日/逐时曲线图与结果 JSON。本模块不解析命令行。"""

import json
import os
from collections import defaultdict
from datetime import datetime

import matplotlib
matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt

plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei"]
plt.rcParams["axes.unicode_minus"] = False


def _is_hourly(arr):
    # 逐时时间带时分部分，逐日只有日期
    return bool(arr) and len(arr[0]["date"]) > 10


def _disp_date(s):
    # 与图片 X 轴格式一致：去掉年份前缀 "YYYY-"，保留 "MM-DD" 或 "MM-DD HH:MM"
    return s[5:] if len(s) > 5 else s


def _series(arr):
    fmt = "%Y-%m-%d %H:%M" if _is_hourly(arr) else "%Y-%m-%d"
    return [datetime.strptime(x["date"], fmt) for x in arr], [x["value"] for x in arr]


def summarize_and_plot(result, load_type="冷+热负荷", out_dir="."):
    """统计汇总 + 绘图 + 保存 JSON，返回待打印的文本行列表。"""
    lines = []
    hot = result.get("model_hot") or []
    cool = result.get("model_cool") or []
    info = result.get("building_info") or {}
    area = info.get("buildingArea", 4000) or 4000

    hourly = _is_hourly(cool) or _is_hourly(hot)
    granularity = "hourly" if hourly else "daily"
    json_path = os.path.join(out_dir, f"load_forecast_result_{granularity}.json")
    stripped = dict(result)
    stripped["model_hot"] = [dict(x, date=_disp_date(x["date"])) for x in hot]
    stripped["model_cool"] = [dict(x, date=_disp_date(x["date"])) for x in cool]
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(stripped, f, ensure_ascii=False)
    lines.append(f"结果数据已保存：{os.path.abspath(json_path)}")

    def brief(arr, name):
        if not arr:
            return None
        vals = [x["value"] for x in arr]
        dates = [x["date"] for x in arr]
        imax, imin = vals.index(max(vals)), vals.index(min(vals))
        avg = sum(vals) / len(vals)
        lines.append(
            f"{name}: 峰值={max(vals):.1f}({dates[imax]})  谷值={min(vals):.1f}({dates[imin]})  "
            f"均值={avg:.1f}  峰值指标={max(vals) / area * 1000:.0f} W/㎡")
        return arr

    h = brief(hot, "热负荷")
    c = brief(cool, "冷负荷")

    # 月度汇总表
    m_hot, m_cool = defaultdict(list), defaultdict(list)
    for x in hot:
        m_hot[x["date"][:7]].append(x["value"])
    for x in cool:
        m_cool[x["date"][:7]].append(x["value"])
    months = sorted(set(m_hot) | set(m_cool))
    if months:
        lines.append("")
        lines.append(f"{'月份':<8}{'月均热':>10}{'月峰热':>10}{'月均冷':>10}{'月峰冷':>10}")
        for m in months:
            hv, cv = m_hot.get(m, []), m_cool.get(m, [])
            lines.append(f"{m:<8}{sum(hv) / len(hv) if hv else 0:>10.1f}"
                         f"{max(hv) if hv else 0:>10.1f}"
                         f"{sum(cv) / len(cv) if cv else 0:>10.1f}"
                         f"{max(cv) if cv else 0:>10.1f}")

    # 曲线图
    png_path = os.path.join(out_dir, f"load_forecast_{granularity}.png")
    per = "逐时" if hourly else "逐日"
    if c and h:
        fig, axes = plt.subplots(2, 1, figsize=(12, 8), sharex=True)
        _draw(axes[0], c, "冷负荷", "#d62728", f"{per}冷负荷预测曲线")
        _draw(axes[1], h, "热负荷", "#1f77b4", f"{per}热负荷预测曲线")
        fig.autofmt_xdate()
    else:
        arr, name, color = (c, "冷负荷", "#d62728") if c else (h, "热负荷", "#1f77b4")
        fig, ax = plt.subplots(figsize=(12, 4.5))
        _draw(ax, arr, name, color, f"{per}{name}预测曲线")
        fig.autofmt_xdate()
    plt.tight_layout()
    plt.savefig(png_path, dpi=150)
    plt.close(fig)
    lines.append(f"负荷曲线图已保存：{os.path.abspath(png_path)}")
    lines.append("")
    lines.append(f"预测条件：{info.get('buildingFunction', '')}建筑，cityId={info.get('cityId', '')}，"
                 f"面积 {area:.0f} ㎡，负荷类型={load_type}。逐时精度请改输出精度后重跑。")
    return lines


def _draw(ax, arr, name, color, title):
    d, v = _series(arr)
    ax.plot(d, v, color=color, lw=1.2, label=title)
    ax.fill_between(d, v, color=color, alpha=0.15)
    vmax = max(v)
    imax = v.index(vmax)
    ax.axhline(vmax, ls="--", c="gray", lw=0.8)
    ax.annotate(f"峰值 {vmax:.1f} ({_disp_date(arr[imax]['date'])})", xy=(d[imax], vmax),
                xytext=(10, -14), textcoords="offset points", fontsize=10)
    ax.set_ylabel(name)
    ax.set_title(title)
    fmt = "%m-%d %H:%M" if _is_hourly(arr) else "%m-%d"
    ax.xaxis.set_major_formatter(mdates.DateFormatter(fmt))
    ax.xaxis.set_major_locator(mdates.AutoDateLocator())
    ax.grid(alpha=0.3)
    ax.legend(loc="upper right")