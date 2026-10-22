/**
 * 死代码扫描：找出**未被引用的导出符号**与**无人导入的文件**。
 *
 * 判据刻意保守（只报「全仓库零引用」的），避免把正常代码误报成死代码 —— 误报比漏报更糟，
 * 它会训练人忽略这份报告（这是本项目已经吃过一次的教训）。
 *
 * 用法：
 *   node <repo>\scripts\find-dead-code.mjs <repoRoot>
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: node find-dead-code.mjs <repoRoot>");
  process.exit(2);
}

/** 递归收集 .ts 文件（跳过 node_modules / lib）。 */
async function collect(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "lib" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collect(path, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

const allFiles = [...(await collect(join(root, "src"))), ...(await collect(join(root, "tests")))];
const srcFiles = await collect(join(root, "src"));

/** 每个文件的源码。 */
const sources = new Map();
for (const file of allFiles) sources.set(file, await readFile(file, "utf8"));

/** 相对路径（报告用）。 */
const rel = (file) => relative(root, file).split(sep).join("/");

// —— 1. 导出符号 ——
/** `export function X` / `export const X` / `export class X` / `export interface X` / `export type X`。 */
const EXPORT_PATTERNS = [
  /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
  /^export\s+const\s+([A-Za-z_$][\w$]*)/gm,
  /^export\s+let\s+([A-Za-z_$][\w$]*)/gm,
  /^export\s+class\s+([A-Za-z_$][\w$]*)/gm,
  /^export\s+interface\s+([A-Za-z_$][\w$]*)/gm,
  /^export\s+type\s+([A-Za-z_$][\w$]*)/gm,
];

const exports = [];
for (const file of srcFiles) {
  const text = sources.get(file);
  for (const pattern of EXPORT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      exports.push({ name: match[1], file: rel(file) });
    }
  }
}

/**
 * 统计一个名字在「其它位置」的出现次数（排除**声明行本身**）。
 *
 * 只排除声明那一行，不能排除所有 `export` 开头的行：`export function f(x: SomeType)` 里的
 * `SomeType` 是**真的在用**，把它排除掉会产生误报（第一版就踩了这个坑）。
 */
function usagesOf(name, definitionFile) {
  let count = 0;
  const word = new RegExp(`(?<![\\w$])${name.replace(/\\$/g, "\\$")}(?![\\w$])`, "g");
  for (const [file, text] of sources) {
    for (const match of text.matchAll(word)) {
      const lineStart = text.lastIndexOf("\n", match.index) + 1;
      const lineEnd = text.indexOf("\n", match.index);
      const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      // 声明行：`export interface X` / `export type X` / `export function X` / `export const X` …
      const declaration = new RegExp(
        `^\\s*export\\s+(?:declare\\s+)?(?:async\\s+)?(?:default\\s+)?(?:function|const|let|class|interface|type|enum)\\s+${name.replace(/\\$/g, "\\$")}(?![\\w$])`,
      );
      if (rel(file) === definitionFile && declaration.test(line)) continue;
      count += 1;
    }
  }
  return count;
}

const deadExports = [];
for (const { name, file } of exports) {
  // 入口文件（index.ts）的导出是**对外 API**，不算死代码。
  if (/(^|\/)index\.ts$/.test(file)) continue;
  const uses = usagesOf(name, file);
  if (uses === 0) deadExports.push({ name, file });
}

// —— 2. 无人导入的文件 ——
const importedFiles = new Set();
for (const [file, text] of sources) {
  for (const match of text.matchAll(/from\s+"([^"]+)"/g)) {
    const spec = match[1];
    if (!spec.startsWith(".")) continue;
    const base = join(file.slice(0, file.lastIndexOf(sep)), spec);
    for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
      if (sources.has(candidate)) importedFiles.add(candidate);
    }
  }
}
const orphanFiles = srcFiles.filter((file) => !importedFiles.has(file) && !/(^|\/)index\.ts$/.test(rel(file)));

console.log(`扫描 ${srcFiles.length} 个源文件、${exports.length} 个导出符号\n`);
console.log(`=== 零引用的导出符号（${deadExports.length}） ===`);
for (const item of deadExports.sort((a, b) => a.file.localeCompare(b.file))) {
  console.log(`  ${item.file}: ${item.name}`);
}
console.log(`\n=== 无人导入的文件（${orphanFiles.length}） ===`);
for (const file of orphanFiles.sort()) console.log(`  ${rel(file)}`);
