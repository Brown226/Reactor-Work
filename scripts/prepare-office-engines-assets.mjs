#!/usr/bin/env node
/**
 * office-engines 资产 staging：把办公四件套 skill 运行时所需的本地引擎（LibreOffice、
 * 便携 Python + wheels、CJK 字体）收进只读资产树，供 electron-builder 打进安装包
 * （bundled-tools/<platformKey>/office-engines → resources/tools/office-engines，
 * 见 packages/desktop/electron-builder.config.js 的 extraResources）。
 *
 * 固定策略（对齐 scripts/prepare-file-tools-assets.mjs）：
 * - 每个资产记录 url + sha256，写入 scripts/office-engines-assets.json；
 *   首次执行用 --record 生成清单（下载后计算），之后任何 hash 不符即失败，禁止漂移；
 * - LibreOffice 走清华镜像（国内快）为主、官方源兜底；msi 用 7z 解包（无需管理员权限，
 *   不用 msiexec /a 的管理员安装模式）；
 * - Python 用官方 embeddable 发行版：解包后复制 python.exe→python3.exe（Windows 上
 *   skill 脚本统一调用 python3，见四件套 env_check.sh 的 python3 检查），并把
 *   Lib/site-packages 写进 python312._pth；
 * - wheels 直接解包进 site-packages（wheel 即 zip；含 C 扩展的 cp312 win_amd64 wheel
 *   与 embeddable ABI 兼容），closure 为人工维护列表（见 WHEEL_CLOSURE）。
 *
 * 用法：
 *   node scripts/prepare-office-engines-assets.mjs [--platform win32-x64] [--record]
 *     [--stage libreoffice|python|fonts]
 *
 * 分阶段：LibreOffice 解包+拷贝体积大（数百 MB），单进程长跑容易被环境杀掉；
 * 用 --stage 拆成三次短任务执行，--skip-extract 复用 .tmp-office-engines/lo-extract。
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
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const recordMode = process.argv.includes("--record");
const stage = readArg("--stage") ?? "all";

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

const platformKey = readArg("--platform") ?? `${process.platform}-${process.arch}`;
const manifestPath = join(repoRoot, "scripts", "office-engines-assets.json");
const stagingRoot = join(
  repoRoot,
  "packages",
  "desktop",
  "bundled-tools",
  platformKey,
  "office-engines",
);
const downloadRoot = join(repoRoot, ".tmp-office-engines");

// ── 版本固定表 ────────────────────────────────────────────────────────────────
const LIBREOFFICE_VERSION = "26.8.0";
const PYTHON_VERSION = "3.12.8";
const PYTHON_BUILD_TAG = "3.12.8"; // python.org ftp 路径段（含补丁号）

const LIBREOFFICE_URLS = {
  "win32-x64": [
    `https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/${LIBREOFFICE_VERSION}/win/x86_64/LibreOffice_${LIBREOFFICE_VERSION}_Win_x86-64.msi`,
    `https://download.documentfoundation.org/libreoffice/stable/${LIBREOFFICE_VERSION}/win/x86_64/LibreOffice_${LIBREOFFICE_VERSION}_Win_x86-64.msi`,
  ],
};

/** key = 资产标识；urls 按顺序尝试；paths = 解包后要保留的产物描述（见各 handler）。 */
const ASSETS = {
  libreoffice: {
    kind: "libreoffice",
    urls: LIBREOFFICE_URLS[platformKey] ?? [],
  },
  python: {
    kind: "python",
    urls: [
      `https://www.python.org/ftp/python/${PYTHON_BUILD_TAG}/python-${PYTHON_VERSION}-embed-amd64.zip`,
    ],
  },
};

/**
 * 分发包钉死清单（版本固定策略）：三个 skill 线的 import 检查全集。
 * docx 线：defusedxml；xlsx 线：openpyxl(+et_xmlfile)、xlsxwriter；
 * pdf 线：pikepdf(+pillow/packaging)、pdfplumber(+pdfminer.six/pypdfium2)、
 * pypdf、reportlab、PyMuPDF（自带 mupdf）、cryptography（pdfminer AES）、lxml。
 *
 * 为什么钉文件名而不是"取最新"：镜像 JSON API 的 urls 顺序不稳定，两次解析会选到不同
 * 版本（实测 lxml 5.2.2/5.3.0、pikepdf 9.1.1/10.14.0 都出现过），导致 sha256 校验失败、
 * 产物不可复现。钉死后 URL 仍走镜像 JSON API 按文件名取（下载地址含 hash 路径段，
 * 无法手拼），但选择结果是确定的。升级 = 改这里的文件名 + 删 manifest 对应条目重跑。
 */
const PACKAGE_PINS = {
  // docx 线真实脚本 import（add_toc_placeholders.py / toc_validate.py 均 import docx）。
  "python-docx": "python_docx-1.1.2-py3-none-any.whl",
  defusedxml: "defusedxml-0.7.1-py2.py3-none-any.whl",
  openpyxl: "openpyxl-3.1.5-py2.py3-none-any.whl",
  et_xmlfile: "et_xmlfile-2.0.0-py3-none-any.whl",
  xlsxwriter: "xlsxwriter-3.2.9-py3-none-any.whl",
  pikepdf: "pikepdf-10.14.0-cp312-cp312-win_amd64.whl",
  pdfplumber: "pdfplumber-0.11.10-py3-none-any.whl",
  "pdfminer.six": "pdfminer_six-20260107-py3-none-any.whl",
  // pdfminer.six 的传递依赖（纯包）。
  "charset-normalizer": "charset_normalizer-3.3.2-py3-none-any.whl",
  // cryptography 的传递依赖（C 扩展，cp312 win wheel）。
  cffi: "cffi-1.17.0-cp312-cp312-win_amd64.whl",
  // python-docx 的传递依赖（纯包）。注意 PyPI 规范名用连字符；JSON API 对下划线形式
  // 会 404 或返回错误项目，pin 的 key 必须与规范名一致。
  "typing-extensions": "typing_extensions-4.12.2-py3-none-any.whl",
  pypdfium2: "pypdfium2-4.30.0-py3-none-win_amd64.whl",
  pypdf: "pypdf-4.3.1-py3-none-any.whl",
  reportlab: "reportlab-4.2.2-py3-none-any.whl",
  PyMuPDF: "pymupdf-1.28.2-cp310-abi3-win_amd64.whl",
  cryptography: "cryptography-43.0.0-cp37-abi3-win_amd64.whl",
  pillow: "pillow-10.4.0-cp312-cp312-win_amd64.whl",
  lxml: "lxml-5.3.0-cp312-cp312-win_amd64.whl",
  packaging: "packaging-24.1-py3-none-any.whl",
  // OCR 线（office_skill_lib.ocr）：onnxruntime + numpy；不用 RapidOCR（会拖进 opencv ~44MB）。
  onnxruntime: "onnxruntime-1.25.1-cp312-cp312-win_amd64.whl",
  numpy: "numpy-2.2.6-cp312-cp312-win_amd64.whl",
  flatbuffers: "flatbuffers-25.12.19-py2.py3-none-any.whl",
  protobuf: "protobuf-7.36.2-py3-none-any.whl",
  // 公式线（office_skill_lib.omml）：LaTeX → MathML
  latex2mathml: "latex2mathml-3.81.1-py3-none-any.whl",
  // pptx 公式插入（insert_math.py → mc:AlternateContent）
  "python-pptx": "python_pptx-1.0.2-py3-none-any.whl",
};

/**
 * CJK 字体：必须是 **TrueType outlines**（ReportLab TTFont 可嵌）。
 * notofonts 的 OTF/CFF 与 Noto CJK TTC 会被 skill_fonts 跳过——此前下 OTF 是无效资产。
 * 钉 gstatic Noto Sans SC TTF + sha256（与 LeAgent FONT_MANIFEST 同源）；国内走 loli 镜像。
 * 失败不阻塞，env_check 回退系统字体。
 */
const FONT_MANIFEST = {
  "NotoSansSC-Regular.ttf": {
    urls: [
      "https://fonts.gstatic.com/s/notosanssc/v40/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaG9_FnYw.ttf",
      "https://gstatic.loli.net/s/notosanssc/v40/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaG9_FnYw.ttf",
    ],
    sha256: "450625c8d46ab3df97b7904ded955ec2746d17ec76740cb1e91d1ba63a0f89af",
  },
  "NotoSansSC-Bold.ttf": {
    urls: [
      "https://fonts.gstatic.com/s/notosanssc/v40/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaGzjCnYw.ttf",
      "https://gstatic.loli.net/s/notosanssc/v40/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaGzjCnYw.ttf",
    ],
    sha256: "0066a522a1ac007c1d72bc4fccb114f80ff7294641c78cead9715bd14d43b9ea",
  },
};

/** PP-OCRv5 mobile（与历史 file-tools 资产同源，sha256 一致）。 */
const OCR_MODEL_REPO = "https://hf-mirror.com/x3zvawq/paddleocr-js-onnx/resolve/main";
const OCR_MODEL_FILES = [
  {
    path: "ppocr_v5_mobile/PP-OCRv5_mobile_det_infer.onnx",
    sha256: "4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae",
  },
  {
    path: "ppocr_v5_mobile/PP-OCRv5_mobile_rec_infer.onnx",
    sha256: "86b1f8bffa31748e0d6364a98af983bbd33b92523141d4a02fa587b4b66b54af",
  },
  {
    path: "ppocr_v5_mobile/ppocrv5_dict.txt",
    sha256: "7680a8a77c6617aba27bc9c52d320f451ae7871613a43b5358ac4a68c88d87c0",
  },
];

// ── 清单（hash pin） ──────────────────────────────────────────────────────────
function loadManifest() {
  if (!existsSync(manifestPath)) return {};
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return {};
  }
}

function saveManifest(manifest) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

const manifest = loadManifest();

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function verifyOrRecord(key, path) {
  const hash = sha256File(path);
  const previous = manifest[key]?.sha256;
  if (previous && previous !== hash) {
    throw new Error(`hash mismatch for ${key}: pinned ${previous}, got ${hash}`);
  }
  if (!previous) {
    if (!recordMode) {
      throw new Error(`${key} 未固定 hash：首次执行请加 --record 生成 scripts/office-engines-assets.json`);
    }
    manifest[key] = { sha256: hash };
  }
  return hash;
}

async function download(urls, targetPath) {
  mkdirSync(dirnameOf(targetPath), { recursive: true });
  const errors = [];
  for (const url of urls) {
    console.log(`  ↓ ${url}`);
    const result = spawnSync("curl", ["-fSL", "--retry", "3", "-o", targetPath, url], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (result.status === 0 && existsSync(targetPath) && statSync(targetPath).size > 0) {
      return;
    }
    errors.push(url);
  }
  throw new Error(`download failed: ${errors.join(" | ")}`);
}

function dirnameOf(path) {
  return resolve(path, "..");
}

function extractZip(zipPath, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  const result = spawnSync("7z", ["x", "-y", `-o${targetDir}`, zipPath], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (result.status !== 0) throw new Error(`7z extract failed: ${zipPath}`);
}

function rmrf(path) {
  rmSync(path, { force: true, recursive: true });
}

// ── LibreOffice ──────────────────────────────────────────────────────────────
function stageLibreOffice() {
  const asset = ASSETS.libreoffice;
  const msiPath = join(downloadRoot, `LibreOffice_${LIBREOFFICE_VERSION}.msi`);
  if (!existsSync(msiPath)) {
    download(asset.urls, msiPath);
  }
  verifyOrRecord("libreoffice.msi", msiPath);

  // 直接解压到目标目录：不落 lo-extract 中间树（大拷贝会被环境静默杀死，且多占 1.5GB 磁盘）。
  const sofficeName = process.platform === "win32" ? "soffice.exe" : "soffice";
  const target = join(stagingRoot, "libreoffice");
  if (existsSync(join(target, sofficeName))) {
    console.log(`  ✓ LibreOffice ${LIBREOFFICE_VERSION} 已就绪（幂等跳过；--record 仍校验 msi hash）`);
    return;
  }
  rmrf(target);
  mkdirSync(target, { recursive: true });
  extractZip(msiPath, target);
  if (!existsSync(join(target, sofficeName))) {
    throw new Error("LibreOffice 解包后未找到 soffice 可执行文件");
  }
  console.log(`  ✓ LibreOffice ${LIBREOFFICE_VERSION} → tools/office-engines/libreoffice`);
}

// ── Python + wheels ──────────────────────────────────────────────────────────
function stagePython() {
  const asset = ASSETS.python;
  const zipPath = join(downloadRoot, `python-${PYTHON_VERSION}-embed-amd64.zip`);
  if (!existsSync(zipPath)) {
    download(asset.urls, zipPath);
  }
  verifyOrRecord("python.embed", zipPath);

  // 幂等暂存：不整体 wipe pythonRoot —— 曾经「失败即全丢」，第 N 个包解析失败会把
  // 前 N-1 个已装包一起清掉。7z x -y 覆盖解压即可增量续跑。
  const pythonRoot = join(stagingRoot, "python");
  extractZip(zipPath, pythonRoot);

  // Windows 上 skill 统一调用 python3；embeddable 只带 python.exe。
  const pythonExe = join(pythonRoot, "python.exe");
  if (existsSync(pythonExe)) {
    copyFileSync(pythonExe, join(pythonRoot, "python3.exe"));
  }

  // site-packages 生效：embeddable 的 ._pth 不含 import site。
  const [major, minor] = PYTHON_VERSION.split(".");
  const pthPath = join(pythonRoot, `python${major}${minor}._pth`);
  const pthLines = existsSync(pthPath)
    ? readFileSync(pthPath, "utf8").split(/\r?\n/)
    : ["python312.zip", "."];
  if (!pthLines.includes("import site")) pthLines.push("import site");
  if (!pthLines.includes("Lib\\site-packages") && !pthLines.includes("Lib/site-packages")) {
    pthLines.push("Lib\\site-packages");
  }
  writeFileSync(pthPath, `${pthLines.filter(Boolean).join("\n")}\n`, "utf8");

  const sitePackages = join(pythonRoot, "Lib", "site-packages");
  mkdirSync(sitePackages, { recursive: true });
  for (const name of Object.keys(PACKAGE_PINS)) {
    stagePythonPackage(name, sitePackages);
  }
  stageOfficeSkillLib(sitePackages);
  stageOcrModels(stagingRoot);
  console.log(
    `  ✓ Python ${PYTHON_VERSION} + ${Object.keys(PACKAGE_PINS).length} packages → tools/office-engines/python`,
  );
}

/** 共享 skill 运行时库（ocr.py 等）拷进 site-packages，供 ocr_scan 等 `python -m office_skill_lib.ocr` 调用。
 *  刻意用 copyFileSync 而非 cpSync：工作区路径含中文时 cpSync 递归复制会让 Node 直接崩（STATUS_STACK_BUFFER_OVERRUN）。 */
function stageOfficeSkillLib(sitePackages) {
  const source = join(repoRoot, "scripts", "office_skill_lib");
  if (!existsSync(join(source, "ocr.py"))) {
    throw new Error(`缺少 ${source}/ocr.py（office_skill_lib 共享模块）`);
  }
  const target = join(sitePackages, "office_skill_lib");
  rmrf(target);
  mkdirSync(target, { recursive: true });
  for (const file of readdirSync(source)) {
    const from = join(source, file);
    if (!statSync(from).isFile()) continue;
    copyFileSync(from, join(target, file));
  }
  console.log(`  ✓ office_skill_lib → site-packages/office_skill_lib`);
}

/** PP-OCRv5 mobile 模型 + 字典（与历史 file-tools 资产同源）。 */
function stageOcrModels(stagingRoot) {
  const modelsRoot = join(stagingRoot, "ocr-models");
  mkdirSync(modelsRoot, { recursive: true });
  for (const model of OCR_MODEL_FILES) {
    const fileName = model.path.split("/").pop();
    const target = join(modelsRoot, fileName);
    if (existsSync(target) && sha256File(target) === model.sha256) {
      console.log(`  ✓ ocr-models/${fileName}（缓存命中）`);
      continue;
    }
    // 优先复用 file-tools 旧缓存，避免重复下载 20MB 模型
    const cached = join(repoRoot, "apps/zcode-cli/packages/file-tools-plugin/assets/win32-x64/ocr-models", fileName);
    if (existsSync(cached) && sha256File(cached) === model.sha256) {
      copyFileSync(cached, target);
      console.log(`  ✓ ocr-models/${fileName}（自 file-tools 资产复用）`);
      continue;
    }
    download([`${OCR_MODEL_REPO}/${model.path}`], target);
    const digest = sha256File(target);
    if (digest !== model.sha256) {
      throw new Error(`sha256 不匹配：${fileName}（${digest} ≠ ${model.sha256}）`);
    }
    console.log(`  + ocr-models/${fileName}`);
  }
}

function stagePythonPackage(name, sitePackages) {
  const filename = PACKAGE_PINS[name];
  const pkgPath = join(downloadRoot, "packages", filename);
  if (!existsSync(pkgPath)) {
    download([resolvePinnedUrl(name, filename)], pkgPath);
  }
  verifyOrRecord(`package:${name}`, pkgPath);
  extractZip(pkgPath, sitePackages);
  console.log(`    + ${name} (${filename})`);
}

/** 按钉死的文件名从镜像 JSON API 取下载地址（地址含 hash 路径段，无法手拼）。
 *  选择结果完全确定：目录里没有该文件名就等于镜像也没有，直接报错，不做任何取最新回退。
 *  必须用**版本级** JSON（/pypi/<name>/<ver>/json）：项目级 /json 只含最新版 urls，
 *  钉旧版（如 onnxruntime==1.25.1）会在最新列表里找不到文件名。 */
const PYPI_MIRRORS = [
  'https://pypi.tuna.tsinghua.edu.cn/pypi',
  'https://pypi.org/pypi',
];

function versionFromWheelFilename(filename) {
  // PEP 427: {distribution}-{version}-{python}-{abi}-{platform}.whl
  const m = /-([0-9][^-]*)-[^-]+-[^-]+-[^-]+\.whl$/i.exec(filename);
  return m?.[1] ?? null;
}

function resolvePinnedUrl(name, filename) {
  const version = versionFromWheelFilename(filename);
  if (!version) {
    throw new Error(`无法从文件名解析版本：${filename}`);
  }
  const errors = [];
  for (const mirror of PYPI_MIRRORS) {
    const api = `${mirror}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`;
    try {
      const info = JSON.parse(execCapture("curl", ["-fSL", api]));
      const hit = (info.urls ?? []).find((file) => file.filename === filename);
      if (hit?.url) return hit.url;
      errors.push(`${mirror}: 无 ${filename}（${version} 列表现有 ${(info.urls ?? []).length} 个文件）`);
    } catch (error) {
      errors.push(`${mirror}: ${error.message?.slice(0, 80)}`);
    }
  }
  throw new Error(
    `resolve ${name} 失败: ${errors.join(" | ")}。如升级版本，改 PACKAGE_PINS 并删 manifest 对应条目`,
  );
}


function execCapture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr?.slice(0, 200)}`);
  }
  return result.stdout;
}

// ── 字体 ─────────────────────────────────────────────────────────────────────
function stageFonts() {
  const fontsRoot = join(stagingRoot, "fonts");
  mkdirSync(fontsRoot, { recursive: true });
  // 清掉旧 OTF/CFF 残留（历史上误下 notofonts OTF，ReportLab 不可嵌）
  for (const stale of ["NotoSansCJKsc-Regular.otf", "NotoSansCJKsc-Bold.otf"]) {
    rmSync(join(fontsRoot, stale), { force: true });
  }
  let downloaded = 0;
  for (const [file, asset] of Object.entries(FONT_MANIFEST)) {
    const target = join(fontsRoot, file);
    try {
      if (existsSync(target) && sha256File(target) === asset.sha256) {
        console.log(`  ✓ fonts/${file}（缓存命中）`);
        downloaded += 1;
        continue;
      }
      download(asset.urls, target);
      const digest = sha256File(target);
      if (digest !== asset.sha256) {
        throw new Error(`sha256 不匹配：${file}（${digest} ≠ ${asset.sha256}）`);
      }
      verifyOrRecord(`font:${file}`, target);
      downloaded += 1;
    } catch (error) {
      console.log(`  ⚠ 字体下载失败（回退系统字体）: ${file} — ${error.message.slice(0, 120)}`);
      rmSync(target, { force: true });
    }
  }
  if (downloaded === 0) {
    rmSync(fontsRoot, { force: true, recursive: true });
    console.log("  ○ 无内置字体，env_check 将按系统字体目录检查");
  } else {
    console.log(`  ✓ ${downloaded} 个 CJK TrueType 字体 → tools/office-engines/fonts`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  if (platformKey !== "win32-x64") {
    console.error(
      `office-engines 资产目前只支持 win32-x64（当前 ${platformKey}）；` +
        "darwin/linux 需要在 ASSETS/LIBREOFFICE_URLS 与 wheel 平台标签中扩展后重跑。",
    );
    process.exit(1);
  }

  mkdirSync(downloadRoot, { recursive: true });
  mkdirSync(stagingRoot, { recursive: true });

  console.log(`[office-engines] platform=${platformKey} stage=${stage}${recordMode ? " (record 模式)" : ""}`);
  if (stage === "all" || stage === "libreoffice") {
    // 默认策略（docs/内网办公四件套-fork-spec.md 7.0）：LibreOffice 不打包，Office/WPS
    // 基镜像或 COM 垫片承担渲染。只有明确决定打包时才暂存，防止 `--stage all` 顺手带出 1.6GB。
    console.log(
      "  ⚠ 即将暂存 LibreOffice 1.6GB 进安装包。当前内网策略是不打包；确定要打包请继续，否则只跑 --stage python。",
    );
    stageLibreOffice();
  }
  if (stage === "all" || stage === "python") stagePython();
  if (stage === "all" || stage === "fonts") stageFonts();

  if (recordMode) {
    saveManifest(manifest);
    console.log(`[office-engines] hash 清单已写入 ${manifestPath}`);
  }
  console.log(`[office-engines] 完成：${stagingRoot}`);
}

main();
