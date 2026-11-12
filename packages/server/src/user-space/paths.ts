import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { SpaceError } from "./errors.js";

/**
 * 我的空间路径规则（方案 §5 安全不变量 1/2/4）。
 *
 * 所有入口（query / JSON body / 回收站 meta / 分享记录）都必须先过
 * normalizeSpacePath 或 validateSegment；只有这样才能保证「相对路径 + 不越界」
 * 不是靠每个 handler 各自记得做。
 */

/** 回收站目录名：空间根下保留，任何层级都不允许用户创建/访问。 */
export const TRASH_DIR_NAME = ".trash";

/** 单段名称字符上限（常见文件系统上限 255 字节；字符数放宽到 255，字节数由上传截断兜底）。 */
const MAX_NAME_LENGTH = 255;
/** 上传名截断目标：留出余量，避免中文名按 UTF-8 计算超过文件系统 255 字节上限。 */
const MAX_NAME_BYTES = 240;
/** 相对路径总长度上限，防止构造超长字符串消耗内存。 */
const MAX_PATH_LENGTH = 1024;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f]+/g;
/** Windows 文件名保留字符：服务端可能跑在 Windows 开发机，统一按可移植规则拒绝。 */
const WINDOWS_FORBIDDEN_CHARS = /[<>:"|?*]/;
const WINDOWS_FORBIDDEN_CHARS_GLOBAL = /[<>:"|?*\\/]/g;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const DRIVE_PREFIX = /^[A-Za-z]:/;

/** 回收站条目 id 是 randomUUID 产物；任何其它形态都不允许拼进路径。 */
export const TRASH_ITEM_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 分享 token：32 字节随机数的 hex 形态。 */
export const SHARE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function isInsideDirectory(root: string, candidate: string): boolean {
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !diff.includes(`..${sep}`));
}

/** 名称是否是系统保留的回收站目录（大小写不敏感，兼容 Windows 文件系统）。 */
export function isReservedName(name: string): boolean {
  return name.toLowerCase() === TRASH_DIR_NAME;
}

/**
 * 访问既有条目时的最小安全检查。
 *
 * 只拦真正危险的形态（空段、`.`/`..`、分隔符、控制字符、保留名）；
 * 不套用 Windows 可移植性规则：agent 直接写盘时可能在 Linux 上生成 `a:b` 这类名字，
 * 空间页必须还能列出/下载/删除它们，否则「产物自动归集」会出现打不开的文件。
 */
function assertSafeSegment(raw: string, label: string): string {
  if (!raw) {
    throw new SpaceError(`${label}不能为空`);
  }
  if (raw.length > MAX_NAME_LENGTH) {
    throw new SpaceError(`${label}过长（最多 ${MAX_NAME_LENGTH} 个字符）`);
  }
  if (raw === "." || raw === "..") {
    throw new SpaceError(`${label}不能是 "." 或 ".."`);
  }
  if (CONTROL_CHARS.test(raw)) {
    throw new SpaceError(`${label}包含控制字符`);
  }
  if (raw.includes("/") || raw.includes("\\")) {
    throw new SpaceError(`${label}不能包含路径分隔符`);
  }
  if (isReservedName(raw)) {
    throw new SpaceError(`${label} "${TRASH_DIR_NAME}" 是系统保留名称`);
  }
  return raw;
}

/**
 * 校验用户新建的文件/目录名（mkdir、rename）。
 * 在安全检查之上追加跨平台可移植性规则：这些名字会由本服务创建，
 * 就应该保证在 Windows 开发机上也能落盘，不制造只在 Linux 可见的文件。
 * 用户显式指定的名称不合法时直接 400，不做静默改写 —— 静默改名会让用户以为操作成功。
 */
export function validateSegment(raw: string, label = "名称"): string {
  assertSafeSegment(raw, label);
  if (WINDOWS_FORBIDDEN_CHARS.test(raw)) {
    throw new SpaceError(`${label}包含非法字符 < > : " | ? *`);
  }
  // Windows 会自动去掉结尾的点和空格，导致「写入的名字」和「磁盘上的名字」不一致。
  if (raw.endsWith(".") || raw.endsWith(" ")) {
    throw new SpaceError(`${label}不能以点或空格结尾`);
  }
  if (WINDOWS_RESERVED_NAME.test(raw)) {
    throw new SpaceError(`${label}是系统保留名称`);
  }
  return raw;
}

/**
 * 把请求里的相对路径规范化成 POSIX 形态（"" 表示空间根）。
 *
 * 拒绝：控制字符、反斜杠、绝对路径、盘符、`.`/`..` 段。
 * 容忍：重复斜杠与结尾斜杠（前端拼接常见），空段直接丢弃。
 */
export function normalizeSpacePath(raw: string | undefined | null): string {
  if (!raw) {
    return "";
  }
  if (raw.length > MAX_PATH_LENGTH) {
    throw new SpaceError("路径过长");
  }
  if (CONTROL_CHARS.test(raw)) {
    throw new SpaceError("路径包含控制字符");
  }
  // 反斜杠在 Linux 是合法文件名字符，但放进来会让「/ 与 \ 哪个是分隔符」产生歧义，
  // 统一拒绝，避免同一路径在不同平台解析成不同目标。
  if (raw.includes("\\")) {
    throw new SpaceError("路径不能包含反斜杠");
  }
  if (raw.startsWith("/") || isAbsolute(raw) || DRIVE_PREFIX.test(raw)) {
    throw new SpaceError("路径必须是相对空间根的路径");
  }
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (!segment) {
      continue;
    }
    if (segment === "." || segment === "..") {
      throw new SpaceError("路径不能包含 . 或 .. 段");
    }
    segments.push(assertSafeSegment(segment, "路径段"));
  }
  return segments.join("/");
}

/**
 * 解析为绝对路径并做二次包含校验。
 *
 * uid 正则与逐段校验已经排除分隔符和 `..`，这里仍再 resolve 后比较一次：
 * 未来有人绕过 normalizeSpacePath 直接调本函数时，越界依然会被拦住（双保险）。
 */
export function resolveSpacePath(workspaceRoot: string, rel: string): string {
  const root = resolve(workspaceRoot);
  const candidate = resolve(root, rel);
  if (!isInsideDirectory(root, candidate)) {
    throw new SpaceError("路径越出空间根目录");
  }
  return candidate;
}

/** uid → 用户空间根绝对路径；uid 本身的合法性由调用方用 isValidUid 先校验。 */
export function resolveUserSpaceRoot(workspaceRoot: string, uid: string): string {
  const root = resolve(workspaceRoot);
  const dir = resolve(root, uid);
  if (!isInsideDirectory(root, dir) || dir === root) {
    throw new SpaceError("uid 解析后的目录越界");
  }
  return dir;
}

/**
 * 上传文件名消毒（方案 §5.4）：只取 basename，替换非法字符，超长截断且保留扩展名。
 * 与 mkdir/rename 的严格校验不同，上传失败对用户成本更高，因此这里做「清洗」而不是报错。
 */
export function sanitizeUploadName(raw: string): string {
  const base = raw.replaceAll("\\", "/").split("/").pop() ?? "";
  let name = base.replace(CONTROL_CHARS_GLOBAL, "").trim();
  name = name.replace(WINDOWS_FORBIDDEN_CHARS_GLOBAL, "_");
  // 纯点号（"." / ".." / "..."）会被文件系统当成特殊项，替换成下划线。
  name = name.replace(/^\.+$/, "_");
  name = name.replace(/[. ]+$/g, "_");
  if (!name) {
    name = "file";
  }
  if (WINDOWS_RESERVED_NAME.test(name) || isReservedName(name)) {
    name = `_${name}`;
  }
  return truncateName(name);
}

function truncateName(name: string): string {
  if (Buffer.byteLength(name, "utf8") <= MAX_NAME_BYTES) {
    return name;
  }
  const ext = extname(name);
  const suffix = ext.length > 0 && Buffer.byteLength(ext, "utf8") <= 32 ? ext : "";
  const stem = suffix ? name.slice(0, name.length - suffix.length) : name;
  let kept = "";
  let bytes = Buffer.byteLength(suffix, "utf8");
  for (const char of stem) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > MAX_NAME_BYTES) {
      break;
    }
    kept += char;
    bytes += charBytes;
  }
  return `${kept || "file"}${suffix}`;
}

export type SpaceCategory = "document" | "image" | "drawing" | "other";

const DOCUMENT_EXTENSIONS = new Set([
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "pdf",
  "txt",
  "md",
]);
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "ico",
  "avif",
  "heic",
  "heif",
  "tif",
  "tiff",
]);
const DRAWING_EXTENSIONS = new Set(["dwg", "dxf"]);

/** 方案 §3 的分类口径：document / image / drawing / other。 */
export function categoryForName(name: string): SpaceCategory {
  const ext = extname(name).toLowerCase().replace(/^\./, "");
  if (DOCUMENT_EXTENSIONS.has(ext)) {
    return "document";
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return "image";
  }
  if (DRAWING_EXTENSIONS.has(ext)) {
    return "drawing";
  }
  return "other";
}

const MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".csv": "text/csv; charset=utf-8",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".dwg": "image/vnd.dwg",
  ".dxf": "image/vnd.dxf",
  ".gif": "image/gif",
  ".gz": "application/gzip",
  ".heic": "image/heic",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
  ".m4a": "audio/mp4",
  ".md": "text/plain; charset=utf-8",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".rar": "application/vnd.rar",
  ".svg": "image/svg+xml",
  ".tar": "application/x-tar",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".txt": "text/plain; charset=utf-8",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml; charset=utf-8",
  ".zip": "application/zip",
  ".7z": "application/x-7z-compressed",
};

export function mimeTypeForName(name: string): string {
  return MIME_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Content-Disposition 同时给 ASCII fallback 与 RFC 5987 的 filename*，
 * 保证中文名在浏览器下载时不变乱码；引号/反斜杠先清掉，避免头注入。
 */
export function contentDispositionHeader(
  disposition: "inline" | "attachment",
  name: string,
): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
