/**
 * 工程连接层的自检：把「为什么连不上」拆成可逐项核对的事实。
 *
 * 逆向自 PKPM Agent 的 doctor 思路：用户报问题时，先给一份结构化诊断，
 * 而不是让他反复试。每一项都只陈述观察到的事实，不下结论。
 *
 * 设计边界：只读检查，不启动软件、不改配置、不写盘。
 */

import { existsSync } from "node:fs";

import { isPortOpen } from "./common.js";
import { candidateRoots, isValidRoot } from "./discovery.js";
import { findProcessesByExecutable } from "./process-discovery.js";
import { getConnectedServers, listSupportedServers } from "./registry.js";

/** 单项检查结果。 */
export interface DiagnosticCheck {
  name: string;
  ok: boolean;
  /** 观察到的事实；失败时是「试了什么、看到什么」。 */
  detail: string;
  /** 建议动作；ok 时为空。 */
  suggestion?: string;
}

/** 自检报告。 */
export interface DiagnosticReport {
  healthy: boolean;
  checks: DiagnosticCheck[];
  /** 当前已连接的软件。 */
  connected: string[];
  /** 已登记支持的软件。 */
  supported: string[];
}

export interface DiagnoseOptions {
  /** 目标软件；缺省检查全部已登记软件的公共项。 */
  server?: string;
  /** 显式可执行文件路径，用于验证用户输入是否正确。 */
  exePath?: string;
}

/**
 * 执行自检。
 *
 * 不抛异常：任何一项检查失败都记入结果，让用户看到完整画面。
 */
export async function diagnose(options: DiagnoseOptions = {}): Promise<DiagnosticReport> {
  const checks: DiagnosticCheck[] = [];

  checks.push(platformCheck());
  checks.push(await pythonCheck());

  if (options.exePath) {
    checks.push(explicitExeCheck(options.exePath));
  }

  if (options.server === "bimbase") {
    checks.push(...(await bimbaseChecks()));
  }

  return {
    healthy: checks.every((check) => check.ok),
    checks,
    connected: getConnectedServers(),
    supported: listSupportedServers(),
  };
}

function platformCheck(): DiagnosticCheck {
  const isWindows = process.platform === "win32";
  return {
    name: "平台",
    ok: isWindows,
    detail: `当前平台：${process.platform}`,
    suggestion: isWindows
      ? undefined
      : "工程软件的 COM 与 MCP 接口几乎都只在 Windows 上可用。当前平台只能验证逻辑，无法真实连接。",
  };
}

async function pythonCheck(): Promise<DiagnosticCheck> {
  const { execFile } = await import("node:child_process");
  const interpreter = process.platform === "win32" ? "python" : "python3";
  return new Promise((resolve) => {
    execFile(interpreter, ["--version"], { timeout: 5000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          name: "Python 解释器",
          ok: false,
          detail: `未找到 ${interpreter}：${error.message}`,
          suggestion: "工程脚本需要 Python。请安装并确保在 PATH 中。",
        });
        return;
      }
      const version = (stdout || stderr).trim();
      resolve({
        name: "Python 解释器",
        ok: true,
        detail: `${interpreter} → ${version}`,
      });
    });
  });
}

function explicitExeCheck(exePath: string): DiagnosticCheck {
  const exists = existsSync(exePath);
  return {
    name: "指定的可执行文件",
    ok: exists,
    detail: exists ? `存在：${exePath}` : `不存在：${exePath}`,
    suggestion: exists ? undefined : "请确认路径与文件名，注意 Windows 路径分隔符。",
  };
}

async function bimbaseChecks(): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];

  // 1. 安装发现
  const roots = await candidateRoots({
    productName: "BIMBase",
    exeName: "BIMBase.exe",
    featurePaths: ["PlantSPythonEnv"],
    exeEnvVars: ["BIMBASE_EXE_PATH", "PLANTS_EXE_PATH"],
    rootEnvVars: ["BIMBASE_HOME", "BIMBASE_ROOT", "PLANTS_HOME", "PLANTS_ROOT"],
  });

  if (roots.length === 0) {
    checks.push({
      name: "安装发现",
      ok: false,
      detail: "四路候选（环境变量 / 注册表三分支）都没有返回路径。",
      suggestion:
        "设置环境变量 BIMBASE_EXE_PATH 指向 BIMBase.exe，或在连接时显式传 exePath。",
    });
  } else {
    const valid = roots.filter((root) => isValidRoot(root.path, ["PlantSPythonEnv"]));
    checks.push({
      name: "安装发现",
      ok: valid.length > 0,
      detail:
        `候选 ${roots.length} 个，通过校验 ${valid.length} 个。` +
        (valid[0] ? `首个可用：${valid[0].path}（来源：${valid[0].source}）` : ""),
      suggestion:
        valid.length > 0
          ? undefined
          : "候选路径都缺少 PlantSPythonEnv 目录，可能不是完整的安装位置。",
    });
  }

  // 2. 进程状态
  const candidates = roots.filter((root) => isValidRoot(root.path, ["PlantSPythonEnv"]));
  const firstRoot = candidates[0];
  if (firstRoot) {
    const exe = `${firstRoot.path}/BIMBase.exe`.replace(/\\/g, "/");
    const processes = await findProcessesByExecutable(exe);
    checks.push({
      name: "运行实例",
      ok: processes.length > 0,
      detail:
        processes.length > 0
          ? `找到 ${processes.length} 个实例，首个 PID ${processes[0]?.pid}`
          : "未发现运行中的实例，连接时会尝试启动。",
    });
  }

  return checks;
}

/** 判断端口是否可连，供实机排查时手工调用。 */
export async function probePort(port: number, host = "127.0.0.1"): Promise<DiagnosticCheck> {
  const open = await isPortOpen(port, host);
  return {
    name: `端口 ${port}`,
    ok: open,
    detail: open ? `${host}:${port} 可连接` : `${host}:${port} 未监听`,
    suggestion: open ? undefined : "确认软件已启动且 MCP 服务已加载。",
  };
}
