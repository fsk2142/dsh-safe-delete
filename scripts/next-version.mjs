/**
 * 按 conventional commits 算下一个版本号（SemVer 2.0.0）。
 *
 * 为什么自己写而不是装工具：本项目把 `pnpm-lock.yaml` 视为受保护文件（加依赖要走审批），
 * 而逻辑其实很小 —— 读提交首行、归类、按最高一级抬版本号。零依赖也意味着不会有
 * 「工具升级后算错」这种额外风险。
 *
 * ## 判定规则（与 SemVer、conventional commits 一致）
 *
 * | 提交里的标记 | 抬哪一段 | 说明 |
 * | --- | --- | --- |
 * | `BREAKING CHANGE:` 页脚 或 `feat!:`/`fix!:` | **MAJOR** | 破坏既有用法 |
 * | `feat:` | **MINOR** | 新增功能 |
 * | `fix:` / `perf:` | **PATCH** | 修 bug、优化 |
 * | `chore:` / `docs:` / `test:` / `build:` / `ci:` / `refactor:` / `style:` | 不抬 | 内部变化 |
 *
 * ## `0.x` 特例（本仓库就在这个区间）
 *
 * SemVer 规范第 4 条：主版本为 0 时公开 API 不稳定。所以这里**不把 0.x 的破坏性变更
 * 抬到 1.0.0** —— 那会假装「API 稳定了」。`0.x` 里破坏性变更抬 MINOR
 * （`0.2.0 → 0.3.0`），这与 npm 生态里多数 0.x 项目的做法一致。
 *
 * ## 怎么用
 *
 * ```
 * node scripts/next-version.mjs            # 只打印算出来的版本（不写文件）
 * node scripts/next-version.mjs --write    # 同时写回 package.json
 * node scripts/next-version.mjs --since v0.2.0   # 指定起点（缺省用 package.json 的版本）
 * ```
 *
 * 起点是**上次发版的 tag**，而不是当前 package.json —— 但仓库里可能还没有 tag，
 * 所以缺省取 `package.json` 的 `version`：那代表「已经发布出去的那个号」，
 * 之后的提交就是待发布的内容。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/** 抬版本的等级，数字越大影响越大。 */
const LEVEL = { none: 0, patch: 1, minor: 2, major: 3 };

/**
 * 把一条提交首行归类。
 * @param {string} subject - 提交首行。
 * @param {string} body - 提交正文（用来找 `BREAKING CHANGE:` 页脚）。
 * @returns {"major" | "minor" | "patch" | "none"}
 */
function levelOf(subject, body) {
  // 破坏性变更：`type!:` 后缀，或正文里的 `BREAKING CHANGE:` 页脚。
  if (/^[a-z]+(\([^)]*\))?![:：]/.test(subject)) return "major";
  if (/^BREAKING[ -]CHANGE[:：]/m.test(body)) return "major";
  if (/^feat(\([^)]*\))?[:：]/.test(subject)) return "minor";
  if (/^(fix|perf)(\([^)]*\))?[:：]/.test(subject)) return "patch";
  // 其余（chore/docs/test/build/ci/refactor/style）不抬版本。
  return "none";
}

/**
 * 抬一个 SemVer。
 * @param {number[]} parts - `[major, minor, patch]`。
 * @param {"major" | "minor" | "patch"} level - 抬哪一段。
 * @returns {number[]}
 */
function bump(parts, level) {
  const [major, minor, patch] = parts;
  if (level === "major") {
    // **0.x 特例**：主版本为 0 时破坏性变更抬 MINOR，不假装 API 已稳定。
    return major === 0 ? [0, minor + 1, 0] : [major + 1, 0, 0];
  }
  if (level === "minor") return [major, minor + 1, 0];
  return [major, minor, patch + 1];
}

/** 读命令行参数。 */
function parseArgs(argv) {
  const out = { write: false, json: false, since: undefined, cwd: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") out.write = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--since") out.since = argv[(index += 1)];
    else if (arg === "--cwd") out.cwd = argv[(index += 1)];
  }
  return out;
}

/** 读 package.json 的 version。 */
function readVersion(cwd) {
  const manifest = JSON.parse(readFileSync(`${cwd}/package.json`, "utf8"));
  const version = typeof manifest.version === "string" ? manifest.version : "";
  const matched = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (matched === null) throw new Error(`package.json 的 version 不是 SemVer：${JSON.stringify(version)}`);
  return { raw: version, parts: [Number(matched[1]), Number(matched[2]), Number(matched[3])] };
}

/**
 * 取起点之后的提交。
 * @param {string} cwd - 仓库目录。
 * @param {string | undefined} since - 起点 ref；**`undefined` 表示读全部历史**。
 */
function commitsSince(cwd, since) {
  // `undefined` 时不带范围（读全部历史）；否则 `<since>..HEAD`。
  // 早先这里给「全部历史」传的是字面量 "HEAD"，拼出 `HEAD..HEAD`（空范围）——
  // 结果永远算成「0 个待发布提交」。这个坑值得留一条注释。
  const args =
    since === undefined
      ? ["-C", cwd, "log", "--format=%s%x01%b%x00"]
      : ["-C", cwd, "log", `${since}..HEAD`, "--format=%s%x01%b%x00"];
  // 用 `-z` 之外的稳定分隔：`%x00` 分提交、`%x01` 分字段，避免正文里的换行干扰解析。
  const raw = execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return raw
    .split("\u0000")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== "")
    .map((chunk) => {
      const [subject = "", body = ""] = chunk.split("\u0001");
      return { subject: subject.trim(), body };
    });
}

/**
 * 判断一个 ref 在仓库里是否存在。
 * @param {string} cwd - 仓库目录。
 * @param {string} ref - 要检查的 ref。
 * @returns {boolean}
 */
function refExists(cwd, ref) {
  try {
    execFileSync("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", ref], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * 算下一个版本。
 * @param {{ cwd: string, since?: string }} options
 * @returns {{ current: string, next: string, level: string, counts: Record<string, number>, total: number, base: string, wholeHistory: boolean }}
 */
export function nextVersion({ cwd, since }) {
  const { raw, parts } = readVersion(cwd);
  // 起点优先级：显式 `--since` → `v<当前版本>` tag → **全部历史**。
  //
  // 第三条是**没有 tag 的仓库**（本仓库当前就是这样）的实际情况：一个 tag 都没有时
  // `v0.1.0` 并不存在，硬用它只会得到 `ambiguous argument`。退回全部历史是对的语义
  // ——「这个号从发布至今累积了哪些改动」。
  const preferred = since ?? `v${raw}`;
  const wholeHistory = !refExists(cwd, preferred);
  // `undefined` = 读全部历史（见 `commitsSince` 的注释）。
  const commits = commitsSince(cwd, wholeHistory ? undefined : preferred);
  const counts = { major: 0, minor: 0, patch: 0, none: 0 };
  let highest = "none";
  for (const commit of commits) {
    const level = levelOf(commit.subject, commit.body);
    counts[level] += 1;
    if (LEVEL[level] > LEVEL[highest]) highest = level;
  }
  const nextParts = highest === "none" ? parts : bump(parts, highest);
  return {
    current: raw,
    next: nextParts.join("."),
    level: highest,
    counts,
    total: commits.length,
    base: wholeHistory ? "全部历史（没有可用的起点 tag）" : preferred,
    wholeHistory,
  };
}

/** 直接运行时的入口。 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  let result;
  try {
    result = nextVersion({ cwd: args.cwd, since: args.since });
  } catch (error) {
    // 指定的起点不存在（例如刚 clone 下来还没有那个 tag）：这是可预期的，说清楚怎么改。
    console.error(`算不出来：${error instanceof Error ? error.message : String(error)}`);
    console.error("提示：用 --since <ref> 指定一个存在的起点，或不带参数（缺省以 package.json 的版本为起点）。");
    process.exitCode = 1;
    return;
  }
  // `--json`：给 `scripts/release.mjs` 这类调用方用的机器可读输出。
  // 与人类可读的几行并存会污染 stdout，所以它独占输出并提前返回。
  if (args.json) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log(`当前版本：${result.current}`);
  console.log(`统计起点：${result.base}`);
  console.log(`待发布提交：${result.total} 个（major ${result.counts.major} / minor ${result.counts.minor} / patch ${result.counts.patch} / 不抬版本 ${result.counts.none}）`);
  console.log(`判定：${result.level === "none" ? "没有需要抬版本的提交" : `抬 ${result.level.toUpperCase()}`}`);
  console.log(`下一个版本：${result.next}`);
  if (args.write) {
    if (result.level === "none") {
      console.log("没有需要抬版本的提交，package.json 未改动。");
      return;
    }
    const path = `${args.cwd}/package.json`;
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.version = result.next;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(`已写回 package.json：${result.current} → ${result.next}`);
  }
}

// 只在直接运行时执行（被单测 import 时不要跑）。
if (process.argv[1] !== undefined && process.argv[1].replaceAll("\\", "/").endsWith("next-version.mjs")) {
  main();
}
