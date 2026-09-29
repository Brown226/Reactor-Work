/**
 * office-engines Python 调用（OCR 等）。
 *
 * 解析顺序与 officeEnginesEnv 对齐：显式 env > ZCODE_SKILL_ENGINE_ROOT 布局。
 * 模块路径：PYTHONPATH 指向 office_skill_lib 的父目录（staging 后 site-packages，
 * 开发态指向 scripts/）。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export class EngineUnavailableError extends Error {
  readonly code = "ENGINE_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "EngineUnavailableError";
  }
}

function isFile(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function firstExisting(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate && isFile(candidate)) return candidate;
  }
  return null;
}

export function resolveOfficePython(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.ZCODE_PYTHON_PATH?.trim();
  if (explicit && isFile(explicit)) return explicit;
  const root = env.ZCODE_SKILL_ENGINE_ROOT?.trim();
  if (root) {
    const hit = firstExisting([
      join(root, "python", "bin", "python3.exe"),
      join(root, "python", "bin", "python3"),
      join(root, "python", "bin", "python.exe"),
      join(root, "python", "python3.exe"),
      join(root, "python", "python3"),
      join(root, "python", "python.exe"),
    ]);
    if (hit) return hit;
  }
  return null;
}

/**
 * 返回 ocr.py 的父目录（含 office_skill_lib 的那一层）。
 * staging：…/python/Lib/site-packages → import office_skill_lib
 * 开发态：…/scripts → import office_skill_lib
 */
export function resolveOfficeSkillLibRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.OFFICE_SKILL_LIB_ROOT?.trim();
  if (explicit && existsSync(join(explicit, "office_skill_lib", "ocr.py"))) {
    return explicit;
  }
  const root = env.ZCODE_SKILL_ENGINE_ROOT?.trim();
  if (root) {
    for (const rel of [
      join("python", "Lib", "site-packages"),
      join("python", "lib", "site-packages"),
      join("site-packages"),
    ]) {
      const candidate = join(root, rel);
      if (existsSync(join(candidate, "office_skill_lib", "ocr.py"))) return candidate;
    }
  }
  // 开发态：本文件在 packages/file-tools-plugin/src → 仓库 scripts/
  const fromModule = resolvePath(MODULE_DIR, "..", "..", "..", "..", "scripts");
  if (existsSync(join(fromModule, "office_skill_lib", "ocr.py"))) return fromModule;
  return null;
}

export function resolveOcrModelsDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.OCR_MODELS_DIR?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  const root = env.ZCODE_SKILL_ENGINE_ROOT?.trim();
  if (root) {
    for (const rel of [join("ocr-models"), join("python", "ocr-models")]) {
      const candidate = join(root, rel);
      if (existsSync(join(candidate, "PP-OCRv5_mobile_det_infer.onnx"))) return candidate;
    }
  }
  return null;
}

export interface PythonJsonResult {
  status: "success" | "failed";
  error?: string;
  message?: string;
  [key: string]: unknown;
}

/** 以 JSON 子进程方式调用 office_skill_lib.ocr CLI。 */
export async function runOcrCli(
  args: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<PythonJsonResult> {
  const env = options.env ?? process.env;
  const python = resolveOfficePython(env);
  if (!python) {
    throw new EngineUnavailableError(
      "未找到 office-engines Python（ZCODE_PYTHON_PATH / ZCODE_SKILL_ENGINE_ROOT）。OCR 需要随包引擎，请安装含办公引擎的版本或由 IT 配置引擎根目录。",
    );
  }
  const libRoot = resolveOfficeSkillLibRoot(env);
  if (!libRoot) {
    throw new EngineUnavailableError(
      "未找到 office_skill_lib.ocr 模块。请运行 prepare-office-engines-assets 或设置 OFFICE_SKILL_LIB_ROOT。",
    );
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    OFFICE_SKILL_LIB_ROOT: libRoot,
    PYTHONPATH: env.PYTHONPATH ? `${libRoot}${delimiter}${env.PYTHONPATH}` : libRoot,
  };
  const models = resolveOcrModelsDir(env);
  if (models) childEnv.OCR_MODELS_DIR = models;

  return await new Promise<PythonJsonResult>((resolve, reject) => {
    const child = spawn(python, ["-m", "office_skill_lib.ocr", ...args], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs ?? 180_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(new EngineUnavailableError(`启动 office-engines Python 失败：${error.message}`));
    });
    child.on("close", (code) => {
      const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
      if (!line) {
        reject(
          new EngineUnavailableError(
            `OCR 引擎无输出（exit=${code}）${stderr ? `：${stderr.slice(0, 200)}` : ""}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(line) as PythonJsonResult);
      } catch {
        reject(new Error(`OCR 引擎输出不是 JSON：${line.slice(0, 200)}`));
      }
    });
  });
}
