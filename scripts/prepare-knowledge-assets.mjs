#!/usr/bin/env node
/**
 * knowledge-engines 资产 staging：把知识库 sidecar 的运行时收进只读资产树，
 * 供 electron-builder 打进安装包（bundled-tools/<platformKey>/knowledge-engines
 * → resources/tools/knowledge-engines）。
 *
 * 设计与体积预算见 `docs/未完成-知识库-sidecar-与检索链路-spec-v1.md` §8。
 *
 * 布局：
 * ```
 * knowledge-engines/
 *   python/                    # 官方 embeddable Python（Windows）或系统 python 链接（Unix）
 *   python/Lib/site-packages/  # 纯 Python wheels（markitdown / sqlite-vec / jieba …）
 *   sidecar/knowledge_sidecar/ # 我们的 Python 代码
 * ```
 *
 * 固定策略（对齐 scripts/prepare-office-engines-assets.mjs）：
 * - 每个资产记录 url + sha256，写入 scripts/knowledge-engines-assets.json；
 *   首次执行用 --record 生成清单（下载后计算），之后任何 hash 不符即失败，禁止漂移；
 * - wheels 直接解包进 site-packages（wheel 即 zip；本项目只收纯 Python wheel，
 *   含 C 扩展的由 office-engines 那套管，避免两份 ABI 基线打架）；
 * - **不含 PyTorch / sentence-transformers**：嵌入与重排走内网/云端 HTTP 服务
 *   （spec §2.2 非目标），这是相对 EvoFlow 省下 400-500MB 的关键。
 *
 * 用法：
 *   node scripts/prepare-knowledge-assets.mjs [--platform win32-x64] [--record]
 *     [--stage python|packages|sidecar]
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";

const require = createRequire(import.meta.url);

const repoRoot = resolve(import.meta.dirname, "..");
const recordMode = process.argv.includes("--record");
const stage = readArg("--stage") ?? "all";
const platformKey = readArg("--platform") ?? `${process.platform}-${process.arch}`;

const manifestPath = join(repoRoot, "scripts", "knowledge-engines-assets.json");
const stagingRoot = join(repoRoot, "packages", "desktop", "bundled-tools", platformKey, "knowledge-engines");
const downloadRoot = join(repoRoot, ".tmp-knowledge-engines");
const sidecarSource = join(
  repoRoot,
  "apps",
  "zcode-cli",
  "packages",
  "knowledge-sidecar",
  "sidecar",
);

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

// ── Python 运行时 ────────────────────────────────────────────────────────────
// 与 office-engines 用同一个 embeddable 版本，便于共用镜像与排障经验；
// 但资产树独立，避免两边 wheel 需求变化时互相牵制（spec §12 待决问题 1 的结论）。
const PYTHON_VERSION = "3.12.8";
const PYTHON_BUILD_TAG = "3.12.8";

/**
 * Python 包清单。
 *
 * 分两类：
 * - `WHEEL_PINS`：有官方 wheel，直接解包进 site-packages；
 * - `SDIST_PINS`：只有源码包（sdist），用宿主 python 的 `pip install --target` 装。
 *
 * 版本已按 PyPI 实测（2026-11-13）钉死，避免"钉了个不存在的版本"。
 *
 * 刻意不含：
 * - onnxruntime / torch / sentence-transformers —— 嵌入与重排走 HTTP 服务（spec §2.2）；
 * - pdfplumber / PyMuPDF —— 已在 office-engines，复用那套，避免双份体积；
 * - numpy —— 向量计算用纯 Python 余弦（P0 数据量下足够）。
 */
/**
 * Python 包清单。
 *
 * 关键决策（2026-11-13 实测）：**不使用 markitdown**。
 *   0.1.x → magika → onnxruntime（14MB）+ ONNX 模型权重下载；
 *   0.0.1a2 → 顶层硬导入 mammoth / pandas / pdfminer / pptx，其中 pandas→numpy（14MB）
 *   且 numpy 是 cp311 ABI wheel，与 Python 3.12 不兼容，实测 import 直接失败。
 * 两版都会把资产树推到 90MB+ 并引入原生 ABI 矩阵。
 *
 * P0 改为自写轻量解析器（纯标准库 zipfile + ElementTree 解析 docx/pptx/xlsx，
 * 见 sidecar 的 parser.py），文档解析能力复用本仓已有的 file-tools-plugin。
 * 这里只留知识库真正需要的少量纯 Python 依赖：
 *   - jieba：中文分词（FTS5 检索必需）
 *   - sqlite-vec：向量索引加速（可选，缺了退化为纯 Python 余弦）
 *   - requests 系：sidecar 调 embedding / rerank HTTP 服务
 *   - beautifulsoup4 / markdownify / puremagic：轻量格式处理（无原生依赖）
 */
const WHEEL_PINS = {
  markdownify: "markdownify-1.2.3-py3-none-any.whl",
  "beautifulsoup4": "beautifulsoup4-4.12.3-py3-none-any.whl",
  soupsieve: "soupsieve-2.6-py3-none-any.whl",
  puremagic: "puremagic-2.2.0-py3-none-any.whl",
  "charset-normalizer": "charset_normalizer-3.3.2-py3-none-any.whl",
  requests: "requests-2.34.2-py3-none-any.whl",
  urllib3: "urllib3-2.8.0-py3-none-any.whl",
  idna: "idna-3.20-py3-none-any.whl",
  certifi: "certifi-2026.10.23-py3-none-any.whl",
};



/**
 * sqlite-vec 是**平台相关** wheel（文件名带 manylinux/macosx），不能钉单个文件名。
 * 按当前 platformKey 从 PyPI 的 urls 里挑匹配的那一个；没有匹配则跳过，
 * 检索自动降级为纯 Python 余弦（store.ensure_fts 之外的 vector_index 会探测）。
 */
const PLATFORM_WHEEL_PINS = {
  "sqlite-vec": { version: "0.1.9", match: sqliteVecPlatformMatch },
};

/**
 * 只有源码包（sdist）的包：pip 从源码装到 `--target`，实现与 wheel 等价。
 *
 * jieba 与 six 至今只发 tar.gz（PyPI 上 `urls` 里没有 wheel），无法像 wheel 那样
 * 解包即用。纯 Python 包无编译风险，`pip install --target` 即可。
 */
const SDIST_PINS = {
  jieba: "jieba==0.42.1",
  six: "six==1.17.0",
};

/** platformKey → sqlite-vec wheel 文件名里的平台标记。 */
function sqliteVecPlatformMatch(platformKey) {
  const map = {
    "linux-x64": ["manylinux", "x86_64"],
    "linux-arm64": ["manylinux", "aarch64"],
    "darwin-x64": ["macosx", "x86_64"],
    "darwin-arm64": ["macosx", "arm64"],
    "win32-x64": ["win_amd64"],
    "win32-arm64": ["win_arm64"],
  };
  return map[platformKey] ?? null;
}

/**
 * PyPI JSON API 只用于**解析下载地址**，不是下载源。
 *
 * 实测（2026-11-13）：清华与阿里镜像的 `/pypi/<name>/<ver>/json` 均返回 404 ——
 * 国内镜像通常只镜像 simple index 与文件，不提供 PEP 691 JSON API。
 * 因此元数据只问官方 PyPI，文件仍优先从镜像下载（见 PREFERRED_DOWNLOAD_HOSTS）。
 */
const PYPI_JSON_APIS = ["https://pypi.org/pypi"];

/**
 * 下载时把 files.pythonhosted.org 的地址换到镜像，省国内带宽与超时。
 * 镜像缺文件时 downloadFile 的多源回退会走原地址。
 */
const PREFERRED_DOWNLOAD_HOSTS = [
  { from: "https://files.pythonhosted.org", to: "https://pypi.tuna.tsinghua.edu.cn" },
];

function mirrorUrl(url) {
  for (const { from, to } of PREFERRED_DOWNLOAD_HOSTS) {
    if (url.startsWith(from)) {
      // pythonhosted 的路径本身就以 /packages/ 开头（/packages/<xx>/<yy>/<hash>/<file>），
      // 镜像的对应前缀也是 /packages，所以只替换 origin，不要再拼 /packages
      // （早期写成 to + "/packages" 会得到 /packages/packages/... 的 404）。
      return to + url.slice(from.length);
    }
  }
  return url;
}

/**
 * 从 PyPI JSON API 取某个版本的文件列表。
 *
 * 不用 spawnSync 起子进程跑 fetch：实测在本机高并发/网络抖动下子进程常以
 * status=5（网络错误）退出，而主进程内直接 fetch 稳定得多。带三次重试。
 */
async function fetchPypiVersionFiles(name, version) {
  const errors = [];
  for (const api of PYPI_JSON_APIS) {
    const url = `${api}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          errors.push(`${url}: HTTP ${response.status}`);
          break; // 4xx/5xx 不重试，换下一个 API
        }
        const payload = await response.json();
        return payload.urls ?? [];
      } catch (error) {
        errors.push(`${url} (attempt ${attempt}): ${error.message}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
  }
  throw new Error(`PyPI 查询失败（${errors.join("; ")}）`);
}

/** 按钉死的文件名从官方 PyPI JSON API 取下载地址（地址含 hash 路径段，无法手拼）。 */
async function resolvePinnedUrl(name, filename) {
  const match = /-([0-9][^-]*)-[^-]+-[^-]+-[^-]+\.whl$/i.exec(filename);
  const version = match?.[1];
  if (!version) throw new Error(`无法从文件名解析版本：${filename}`);
  const files = await fetchPypiVersionFiles(name, version);
  const hit = files.find((file) => file.filename === filename);
  if (!hit?.url) {
    throw new Error(
      `解析 ${filename} 失败：PyPI 上 ${name}==${version} 没有该文件（现有 ${files
        .map((f) => f.filename)
        .slice(0, 4)
        .join(", ")}）。如升级版本，改 WHEEL_PINS 并删清单对应条目。`,
    );
  }
  return mirrorUrl(hit.url);
}

// ── 清单与下载 ───────────────────────────────────────────────────────────────
function loadManifest() {
  if (!existsSync(manifestPath)) return {};
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return {};
  }
}

function saveManifest(manifest) {
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(manifestPath, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function verifyOrRecord(key, path) {
  const manifest = loadManifest();
  const actual = sha256File(path);
  if (recordMode) {
    manifest[key] = { sha256: actual };
    saveManifest(manifest);
    return;
  }
  const expected = manifest[key]?.sha256;
  if (!expected) {
    throw new Error(
      `资产清单缺少 ${key} 的 sha256。首次接入请用 --record 生成 scripts/knowledge-engines-assets.json。`,
    );
  }
  if (expected !== actual) {
    throw new Error(`资产哈希不符：${key}\n  期望 ${expected}\n  实际 ${actual}\n禁止漂移；确认来源后再 --record 重录。`);
  }
}

function extractZip(zipPath, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  const candidates = [
    { command: "7z", args: ["x", "-y", `-o${targetDir}`, zipPath] },
    ...(process.platform === "win32" && systemRoot
      ? [{ command: join(systemRoot, "System32", "tar.exe"), args: ["-xf", zipPath, "-C", targetDir] }]
      : []),
    { command: "tar", args: ["-xf", zipPath, "-C", targetDir] },
    { command: "unzip", args: ["-oq", zipPath, "-d", targetDir] },
  ];
  const failures = [];
  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, candidate.args, {
      stdio: ["ignore", "ignore", "ignore"],
    });
    if (result.status === 0) return;
    failures.push(
      `${candidate.command}${result.error ? ` (${result.error.code ?? result.error.message})` : ` status=${result.status}`}`,
    );
  }

  // 纯 Node 兜底：GNU tar 不支持 zip，而 Linux 容器里常见既无 7z 也无 unzip。
  // wheel 就是 zip，用 fflate 解不需要额外系统依赖。
  try {
    extractZipWithFflate(zipPath, targetDir);
    return;
  } catch (error) {
    failures.push(`fflate (${error.message})`);
  }
  throw new Error(`解包失败：${zipPath}（已尝试：${failures.join("; ")}）`);
}

/** 用 fflate 解 zip（无系统依赖兜底）。 */
function extractZipWithFflate(zipPath, targetDir) {
  const { unzipSync } = require("fflate");
  const files = unzipSync(readFileSync(zipPath));
  for (const [relativePath, bytes] of Object.entries(files)) {
    if (!relativePath || relativePath.endsWith("/")) continue;
    // 防 zip-slip：解包路径必须落在 targetDir 内。
    const outputPath = resolve(targetDir, relativePath);
    const normalizedTarget = resolve(targetDir);
    if (outputPath !== normalizedTarget && !outputPath.startsWith(normalizedTarget + sep)) {
      throw new Error(`非法路径：${relativePath}`);
    }
    mkdirSync(resolve(outputPath, ".."), { recursive: true });
    writeFileSync(outputPath, bytes);
  }
}

async function download(urls, targetPath) {
  mkdirSync(resolve(targetPath, ".."), { recursive: true });
  const { downloadFile } = await import("./lib/download-asset.mjs");
  await downloadFile(urls, targetPath);
  console.log(`    ↓ ${targetPath.slice(repoRoot.length + 1)}`);
}

// ── staging ─────────────────────────────────────────────────────────────────
function stagePython() {
  const isWindows = platformKey.startsWith("win32");
  const pythonRoot = join(stagingRoot, "python");

  if (!isWindows) {
    // Unix 不打包 embeddable：官方只发 Windows 版 embeddable，Linux/macOS 打便携
    // Python 需要额外编译或依赖系统包管理器，收益不抵复杂度。
    // 走「用系统 python3」策略，启动脚本由 prepare 阶段写一个 shim 记录解释器路径。
    mkdirSync(pythonRoot, { recursive: true });
    const systemPython = spawnSync("python3", ["-c", "import sys;print(sys.executable)"], {
      encoding: "utf8",
    });
    if (systemPython.status !== 0) {
      console.warn("  ⚠ 未找到系统 python3；Unix 平台需要运行期可用的 Python 3.10+");
    } else {
      const executable = systemPython.stdout.trim();
      writeFileSync(
        join(pythonRoot, "interpreter.json"),
        `${JSON.stringify({ executable, mode: "system" }, null, 2)}\n`,
        "utf8",
      );
      console.log(`  ✓ Unix：记录系统解释器 ${executable}`);
    }
    return join(pythonRoot, "Lib", "site-packages");
  }

  const major = PYTHON_VERSION.split(".")[0];
  const minor = PYTHON_VERSION.split(".")[1];
  const zipPath = join(downloadRoot, `python-${PYTHON_VERSION}-embed-amd64.zip`);
  return (async () => {
    if (!existsSync(zipPath)) {
      await download(
        [`https://www.python.org/ftp/python/${PYTHON_BUILD_TAG}/python-${PYTHON_VERSION}-embed-amd64.zip`],
        zipPath,
      );
    }
    verifyOrRecord("python.embed", zipPath);
    // 幂等：不整体 wipe —— 第 N 个包失败不该把前 N-1 个已装好的清掉
    // （office-engines 踩过「失败即全丢」）。
    extractZip(zipPath, pythonRoot);

    // skill / sidecar 统一调用 python3；embeddable 只带 python.exe。
    const pythonExe = join(pythonRoot, "python.exe");
    if (existsSync(pythonExe)) copyFileSync(pythonExe, join(pythonRoot, "python3.exe"));

    // embeddable 的 ._pth 默认不含 import site，site-packages 不会生效。
    const pthPath = join(pythonRoot, `python${major}${minor}._pth`);
    const pthLines = existsSync(pthPath)
      ? readFileSync(pthPath, "utf8").split(/\r?\n/)
      : [`python${major}${minor}.zip`, "."];
    if (!pthLines.includes("import site")) pthLines.push("import site");
    if (!pthLines.some((line) => line.replace(/\\/g, "/") === "Lib/site-packages")) {
      pthLines.push("Lib\\site-packages");
    }
    writeFileSync(pthPath, `${pthLines.filter(Boolean).join("\n")}\n`, "utf8");

    const sitePackages = join(pythonRoot, "Lib", "site-packages");
    mkdirSync(sitePackages, { recursive: true });
    console.log(`  ✓ Python ${PYTHON_VERSION} embeddable`);
    return sitePackages;
  })();
}

async function stagePackages(sitePackages) {
  if (!sitePackages) {
    console.warn("  ⚠ 无 site-packages（Unix 走系统 Python，wheels 由系统环境提供）");
    return;
  }
  // 1) 纯 Python wheel：解包即用
  for (const [name, filename] of Object.entries(WHEEL_PINS)) {
    const wheelPath = join(downloadRoot, "wheels", filename);
    if (!existsSync(wheelPath)) {
      await download([await resolvePinnedUrl(name, filename)], wheelPath);
    }
    verifyOrRecord(`wheel:${name}`, wheelPath);
    extractZip(wheelPath, sitePackages);
    console.log(`    + ${name} (${filename})`);
  }

  // 2) 平台相关 wheel：按当前平台挑文件名（sqlite-vec）
  for (const [name, spec] of Object.entries(PLATFORM_WHEEL_PINS)) {
    const markers = spec.match(platformKey);
    if (!markers) {
      console.warn(`    ⚠ ${name}：${platformKey} 无匹配 wheel，跳过（检索将降级为纯 Python 余弦）`);
      continue;
    }
    const filename = await resolvePlatformWheelFilename(name, spec.version, markers);
    if (!filename) {
      console.warn(`    ⚠ ${name}：PyPI 上找不到 ${markers.join("+")} 的 wheel，跳过`);
      continue;
    }
    const wheelPath = join(downloadRoot, "wheels", filename);
    if (!existsSync(wheelPath)) {
      await download([await resolvePinnedUrl(name, filename)], wheelPath);
    }
    verifyOrRecord(`wheel:${name}:${platformKey}`, wheelPath);
    extractZip(wheelPath, sitePackages);
    console.log(`    + ${name} (${filename})`);
  }

  // 3) 只有 sdist 的包：用宿主 pip 装到 --target
  for (const [name, spec] of Object.entries(SDIST_PINS)) {
    const marker = join(sitePackages, `.installed-${name}`);
    if (existsSync(marker)) {
      console.log(`    = ${name}（已装）`);
      continue;
    }
    const result = spawnSync(
      process.env.PYTHON ?? "python3",
      ["-m", "pip", "install", "--no-deps", "--target", sitePackages, spec],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.status !== 0) {
      throw new Error(
        `sdist 安装失败：${spec}\n${(result.stderr ?? "").slice(0, 600)}\n` +
          `提示：该包只有源码包，需要宿主 python3 + pip 可用。`,
      );
    }
    writeFileSync(marker, `${spec}\n`, "utf8");
    console.log(`    + ${name}（sdist → pip --target）`);
  }
}

/** 从 PyPI JSON 里挑出与当前平台匹配的 wheel 文件名。 */
async function resolvePlatformWheelFilename(name, version, markers) {
  const files = await fetchPypiVersionFiles(name, version);
  const hit = files.find(
    (file) => file.filename.endsWith(".whl") && markers.every((m) => file.filename.includes(m)),
  );
  return hit?.filename ?? null;
}

/**
 * 拷 sidecar 代码进资产树。
 *
 * 刻意用 copyFileSync 逐文件而非 cpSync 递归：工作区路径含中文时 cpSync 会让 Node
 * 直接崩（STATUS_STACK_BUFFER_OVERRUN，office-engines 的 stageOfficeSkillLib 踩过）。
 */
function stageSidecar() {
  const target = join(stagingRoot, "sidecar");
  rmSync(target, { force: true, recursive: true });
  const pkgTarget = join(target, "knowledge_sidecar");
  mkdirSync(pkgTarget, { recursive: true });

  const pkgSource = join(sidecarSource, "knowledge_sidecar");
  let copied = 0;
  for (const entry of readdirSync(pkgSource)) {
    const from = join(pkgSource, entry);
    if (!statSync(from).isFile()) continue;
    if (!entry.endsWith(".py")) continue;
    copyFileSync(from, join(pkgTarget, entry));
    copied += 1;
  }
  console.log(`  ✓ sidecar 代码（${copied} 个 .py）→ sidecar/knowledge_sidecar`);
}

function sumDirectorySize(root) {
  let total = 0;
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      // 用 stat 复核：Dirent 的 d_type 在 FUSE / proot 上不可靠
      // （prepare-file-tools-assets.mjs 踩过，硬链接被误报成 symlink）。
      const stats = statSync(full);
      if (stats.isDirectory()) walk(full);
      else if (stats.isFile()) total += stats.size;
    }
  };
  walk(root);
  return total;
}

async function main() {
  console.log(`[knowledge-engines] staging platform: ${platformKey}${recordMode ? "（record 模式）" : ""}`);
  mkdirSync(stagingRoot, { recursive: true });

  let sitePackages = null;
  if (stage === "all" || stage === "python") {
    sitePackages = await stagePython();
  } else {
    sitePackages = join(stagingRoot, "python", "Lib", "site-packages");
  }
  if (stage === "all" || stage === "packages") {
    await stagePackages(sitePackages);
  }
  if (stage === "all" || stage === "sidecar") {
    stageSidecar();
  }

  const total = sumDirectorySize(stagingRoot);
  console.log(
    `[knowledge-engines] staged → ${stagingRoot.slice(repoRoot.length + 1)}（${(total / 1024 / 1024).toFixed(1)} MiB）`,
  );
  console.log(
    "  提示：本资产不含 PyTorch；嵌入与重排走 HTTP 服务（spec §2.2）。",
  );
}

await main();
