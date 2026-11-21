/**
 * 把工程技能的非 TS 资源（SKILL.md / scripts / references / examples）
 * 从 src 拷到 dist。
 *
 * 原因：tsc 只搬 .ts 编译产物，技能正文与 Python 脚本不会被复制。
 * 不拷贝时 `listBuiltinEngineeringSkills()` 在打包后返回 0 条 —— 这与
 * 开发期从 src 运行时能枚举到 22 条的行为不一致。
 *
 * 只拷资源文件，不覆盖 tsc 生成的 .js/.d.ts：目标里已存在的同名文件跳过。
 */
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const SRC = join(PACKAGE_ROOT, "src", "engineering", "skills");
const DIST = join(PACKAGE_ROOT, "dist", "engineering", "skills");

/** 跳过 tsc 产物，只搬资源。 */
const SKIP_EXT = new Set([".js", ".d.ts", ".map", ".ts"]);

async function walk(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      // builtin-skills.js 等源码目录只存在于 dist，src 下没有，跳过。
      await walk(source, target);
      continue;
    }
    if (SKIP_EXT.has(entry.name.slice(entry.name.lastIndexOf(".")))) continue;
    await cp(source, target);
  }
}

try {
  await stat(SRC);
} catch {
  console.log("[engineering-skills] 源目录不存在，跳过资源拷贝。");
  process.exit(0);
}

await mkdir(DIST, { recursive: true });
await walk(SRC, DIST);
console.log("[engineering-skills] 资源已拷贝到 dist/engineering/skills");
