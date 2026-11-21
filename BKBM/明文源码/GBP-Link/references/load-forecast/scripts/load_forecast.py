#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
负荷预测（能耗预测服务 v2.0）调用脚本。

- 认证：固定静态 token，从 .env 读取（键名 HVAC_FORECAST_TOKEN），不做 OAuth token 获取流程。
- CloudWAF 防护：请求 Header 必须携带 User-Agent，否则可能被拦截。
- 服务端会为缺失字段自动补齐默认值，因此 body 只需包含用户明确给出的字段。

用法：
    python load_forecast.py --body <body.json 路径或 JSON 字符串>
    可选：-lt/--load_type   1 热  2 冷  3 冷+热(默认)
          -ot/--output_type 1 逐日(默认)  2 逐时
          -p/--params       "" 或其它的 query 参数，如 "load_type=3&output_type=1"
可选温度阈值 query 参数（走 -p 传，多参数用 & 拼接；未指定时服务端用默认值）：
    min_temp_startup_condition=24            启动空调时的最低温度(℃，GB19577-2024 附录A.2)
    min_temp_startup_heating=-12             室外侧名义制热工况(℃，GB21454-2021 附录A.1)
    max_temp_startup_heating_residence=15    户用建筑启动采暖最高温度(℃，GB21454-2021 附录A.1)
    max_temp_startup_heating_industrial_commercial=13  工商业建筑启动采暖最高温度(℃，GB21454-2021 附录A.1)
示例：
    python load_forecast.py --body body.json -lt 3 -ot 1 -p "min_temp_startup_condition=26"
输出：
    运行目录下生成（daily/hourly 随输出精度而定）：
      load_forecast_result_daily.json   / load_forecast_result_hourly.json  服务完整返回（负荷数组 + 参数回显）
      load_forecast_daily.png           / load_forecast_hourly.png  冷/热负荷曲线图（仅冷/仅热时只画一条，需 matplotlib）
    终端打印：峰/谷/均值、月度汇总表与文件路径。
"""
import os
import sys
import json
import argparse
import urllib.parse
import urllib.request

DEFAULT_BASE_URL = "https://cc.gbcloud.pkpm.cn/hvacaforecast/api/v2.0/get_model_predict"
PLACEHOLDER_TOKEN = "sk-xxxxxxxxx"

# CloudWAF 防护要求携带 User-Agent
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) load-forecast-skill/2.0"


def load_env(path=".env"):
    """读取极简 .env（仅支持 K=V 与 # 注释）。"""
    env = {}
    if not os.path.exists(path):
        return env
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def main():
    parser = argparse.ArgumentParser(description="负荷预测 v2.0 调用脚本")
    parser.add_argument("--body", required=True, help="body JSON（文件路径或 JSON 字符串）")
    parser.add_argument("-lt", "--load_type", default="3",
                        help="负荷类型：1-热负荷；2-冷负荷；3-冷负荷+热负荷（默认 3）")
    parser.add_argument("-ot", "--output_type", default="1",
                        help="输出精度：1-逐日（默认）；2-逐时")
    parser.add_argument("-p", "--params", default="",
                        help="额外的 query 参数，如 'min_temp_startup_heating=-12'（可选）")
    args = parser.parse_args()

    # .env 约定放在本脚本的上一层目录（references/load-forecast/.env）
    env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
    env = load_env(env_path)
    token = env.get("HVAC_FORECAST_TOKEN", "")
    base = env.get("HVAC_FORECAST_BASE_URL", DEFAULT_BASE_URL)

    if not token:
        print("错误：未在 .env 中找到 HVAC_FORECAST_TOKEN。", file=sys.stderr)
        sys.exit(1)
    if token == PLACEHOLDER_TOKEN:
        print("警告：当前 token 为占位值 sk-xxxxxxxxx，请先在 .env 中替换为真实 token。",
              file=sys.stderr)

    # 组装 body
    if os.path.exists(args.body):
        with open(args.body, encoding="utf-8") as f:
            body_raw = f.read()
    else:
        body_raw = args.body
    try:
        body_json = json.loads(body_raw)  # 校验 JSON
    except json.JSONDecodeError as e:
        print(f"错误：body 不是合法 JSON：{e}", file=sys.stderr)
        sys.exit(1)
    payload = json.dumps(body_json, ensure_ascii=False).encode("utf-8")

    # 组装 query
    params = [f"load_type={args.load_type}", f"output_type={args.output_type}"]
    if args.params:
        for item in urllib.parse.parse_qsl(args.params, keep_blank_values=True):
            params.append(f"{urllib.parse.quote(item[0])}={urllib.parse.quote(item[1])}")
    url = f"{base}?{'&'.join(params)}"

    # 发起请求
    req = urllib.request.Request(url, data=payload, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("User-Agent", USER_AGENT)  # CloudWAF 防护必带

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"错误：HTTP {e.code} {e.reason}。请检查 token 是否正确。", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"错误：请求失败：{e}", file=sys.stderr)
        sys.exit(1)

    # 保存 JSON + 绘图 + 统计，打印汇总（峰/谷/均值、月度表、文件路径）
    summarize(result, load_type_label(args.load_type))


def load_type_label(lt):
    return {"1": "热负荷", "2": "冷负荷", "3": "冷+热负荷", "1热": "热负荷",
            "2冷": "冷负荷", "3冷热": "冷+热负荷"}.get(str(lt), f"类型{lt}")


def summarize(result, load_type, out_dir="."):
    """保存完整返回 JSON、绘制逐日/逐时曲线图、打印统计汇总。

    曲线图需 matplotlib；若环境未安装，则退化为仅保存 JSON，并在终端提示。
    """
    try:
        # 让脚本同目录内的 report.py 可被导入
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from report import summarize_and_plot
        for line in summarize_and_plot(result, load_type=load_type, out_dir=out_dir):
            print(line)
    except ImportError as e:
        fallback_save_json(result, out_dir)
        print(f"提示：绘图/统计模块未就绪（缺 matplotlib 或 report.py），仅保存结果 JSON，未生成曲线图：{e}",
              file=sys.stderr)
    except Exception as e:
        fallback_save_json(result, out_dir)
        print(f"提示：绘图/统计执行失败，仅保存结果 JSON：{e}", file=sys.stderr)


def fallback_save_json(result, out_dir="."):
    granularity = "hourly" if _is_result_hourly(result) else "daily"
    json_path = os.path.join(out_dir, f"load_forecast_result_{granularity}.json")
    stripped = dict(result)
    for key in ("model_hot", "model_cool"):
        stripped[key] = [dict(x, date=_strip_year_date(x["date"])) for x in (result.get(key) or [])]
    try:
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(stripped, f, ensure_ascii=False)
        print(f"结果数据已保存：{os.path.abspath(json_path)}")
    except Exception as e:
        print(f"错误：结果 JSON 保存失败：{e}", file=sys.stderr)


def _is_result_hourly(result):
    for key in ("model_hot", "model_cool"):
        arr = result.get(key) or []
        if arr and len(arr[0].get("date", "")) > 10:
            return True
    return False


def _strip_year_date(s):
    # 与图片 X 轴格式一致：去掉年份前缀 "YYYY-"，保留 "MM-DD" 或 "MM-DD HH:MM"
    return s[5:] if len(s) > 5 else s


if __name__ == "__main__":
    main()