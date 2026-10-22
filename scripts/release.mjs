#!/usr/bin/env node
/**
 * 发版：算版本号 → 重建产物 → 提交 → 打 tag → 推送 → 建 GitHub Release。
 *
 * ## 为什么要有这个脚本
 *
 * 以前发版是手工六步，其中「建 GitHub Release」这一步经常漏 —— 而插件市场的
 * **更新说明只认 Release**（不是 tag）。漏了它，市场里就只显示「有新版本」却
 * 说不出更新了什么（2026-10-21 用户报障）。
 *
 * ## 前置
 *
 * 环境变量 `GITHUB_TOKEN`（细粒度 token 也行，需要 Contents: Read and write）。
 * 没设 token 时**跳过建 Release 并明确提示**，其余步骤照常 —— 不能让一个附加步骤
 * 把发版卡死。
 *
 * ## 用法
 *
 * ```
 * node scripts/release.mjs --note "这次改了什么"      # 完整发版
 * node scripts/release.mjs --note "..." --dry-run     # 只算版本号
 * ```
 *
 * 提交信息从 `git log` 自动汇总（自上一个 tag 起），`--note` 是给 Release 的补充说明。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** 读一个命令的 stdout。 */
function run(args, options = {}) {
  return execFileSync(args[0], args.slice(1), { encoding: "utf8", ...options }).trim();
}

/** 读 package.json 的 name 与 repository。 */
function packageInfo() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const match = typeof url === "string" ? /github\.com[:/]([^/]+)\/([^/#.]+)/.exec(url) : null;
  return {
    name: pkg.name,
    version: pkg.version,
    owner: match?.[1],
    repo: match?.[2],
  };
}

/**
 * 建 GitHub Release。
 * @returns 成功与否；没 token 时返回 `"no-token"`。
 */
async function createRelease({ owner, repo, tag, title, body }) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token === undefined || token === "") return "no-token";
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ tag_name: tag, name: title, body, draft: false, prerelease: false }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub 拒绝了建 Release（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }
  return "ok";
}

/** 主流程。 */
async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const noteIndex = argv.indexOf("--note");
  const note = noteIndex >= 0 ? (argv[noteIndex + 1] ?? "") : "";

  const info = packageInfo();

  // 1. 算下一个版本（复用既有脚本，它是唯一真相）。
  const next = JSON.parse(run(["node", "scripts/next-version.mjs", "--json"]) || "{}");
  if (next.level === "none") {
    console.log("没有需要抬版本的提交，退出。");
    return;
  }
  console.log(`当前 ${next.current} → 下一个 ${next.next}（${next.level}）`);
  if (dryRun) return;

  // 2. 写版本号并重建产物（版本号是构建期注入的）。
  run(["node", "scripts/next-version.mjs", "--write"]);
  console.log("已写回 package.json");
  run(["pnpm", "build"], { stdio: "inherit" });
  console.log("产物已重建");

  // 3. 全量验证：任何一步失败都不该发出去。
  run(["npx", "tsc", "--noEmit"], { stdio: "inherit" });
  run(["npx", "vitest", "run"], { stdio: "inherit" });

  // 4. 提交 + 打 tag + 推送。
  const tag = `v${next.next}`;
  run(["git", "add", "-A"]);
  run(["git", "commit", "-m", `chore(release): ${tag}`]);
  run(["git", "tag", tag]);
  run(["git", "push", "origin", "main", "--tags"]);
  console.log(`已推送 ${tag}`);

  // 5. 建 Release（市场靠它显示更新说明）。
  const commits = run(["git", "log", "--oneline", `${next.current}..${tag}`])
    .split("\n")
    .filter((line) => line !== "" && !line.includes("chore(release)"))
    .map((line) => `- ${line.replace(/^[a-f0-9]+ /, "")}`)
    .join("\n");
  const body = note === "" ? commits : `${note}\n\n## 变更\n\n${commits}`;
  const result = await createRelease({
    owner: info.owner,
    repo: info.repo,
    tag,
    title: tag,
    body,
  });
  if (result === "no-token") {
    console.warn("⚠ 没设 GITHUB_TOKEN，跳过建 Release。市场将看不到这次的更新说明。");
    console.warn("  设好 token 后可以手动补：GitHub 仓库页 → Releases → Draft a new release");
  } else {
    console.log(`已建 Release：https://github.com/${info.owner}/${info.repo}/releases/tag/${tag}`);
  }
}

await main();
