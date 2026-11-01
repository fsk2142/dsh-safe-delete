#!/usr/bin/env node
/**
 * 发版：算版本号 → 重建产物 → 提交 → 打 tag → 推送 → 建 GitHub Release。
 *
 * ## 为什么要有这个脚本
 *
 * 以前发版是手工六步，其中「建 GitHub Release」这一步经常漏 —— 而插件市场的
 * **更新说明只认 Release**（不是 tag）。漏了它，市场里就只显示「有新版本」却
 * 说不出更新了什么。
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

/**
 * 读一个命令的输出。
 *
 * ## 必须区分"捕获输出"与"继承输出"（2026-11-01 审查 SD-14 断点 1）
 *
 * 第一版无条件 `.trim()`：
 *
 * ```js
 * return execFileSync(args[0], args.slice(1), { encoding: 'utf8', ...options }).trim()
 * ```
 *
 * 而 `build` / `typecheck` / `test` 用 `stdio: 'inherit'` —— 那种模式下
 * `execFileSync` 返回 **null**，`.trim()` 立刻抛 TypeError。
 *
 * 结果：发布脚本在跑完 build 之后崩溃，而版本号已经被改过 ——
 * 处于半途状态。隔离复现：用一个成功的空 Node 程序即可触发。
 *
 * @param {string[]} args 命令与参数。
 * @param {object} options execFileSync 选项。
 * @returns 捕获模式下是去尾空白的 stdout；继承模式下是空串。
 */
function run(args, options = {}) {
  const result = execFileSync(args[0], args.slice(1), { encoding: "utf8", ...options });
  // 继承输出时没有返回值 —— 不要对 null 调 trim()。
  return typeof result === "string" ? result.trim() : "";
}

/**
 * 跑一个 pnpm 子命令（跨平台）。
 *
 * ## 为什么不能直接 `execFileSync('pnpm', ...)`（2026-11-01 审查 SD-14 断点 2）
 *
 * Windows 上 `pnpm` 是 `.cmd` 包装脚本。`execFileSync` **不会**像 shell 那样
 * 解析 PATHEXT，于是直接 `ENOENT: spawnSync pnpm`。复审在本机实测
 * pnpm / npx 入口都 ENOENT —— 而这不是所有平台都如此，所以只在 Windows
 * 上暴露。
 *
 * 两条回退路径，按可靠性排序：
 *   1. `shell: true` —— 由系统 shell 解析 `.cmd`（Windows）/ 可执行文件
 *      （POSIX）。这是最通用的做法；
 *   2. 找不到 pnpm 时明确报错，而不是让 build 静默跳过。
 *
 * @param {string[]} args pnpm 之后的参数。
 */
function runPnpm(args) {
  try {
    const result = execFileSync("pnpm", args, {
      encoding: "utf8",
      stdio: "inherit",
      // shell 解析是必要的：Windows 的 pnpm.cmd 不能被 execFile 直接执行。
      shell: true,
    });
    void result;
  } catch (error) {
    throw new Error(
      `failed to run \`pnpm ${args.join(" ")}\`: ${
        error instanceof Error ? error.message : String(error)
      }\n` +
        "The release was stopped before any remote change. Fix pnpm on PATH and retry.",
    );
  }
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

/**
 * 查某个 tag 是否已有 Release。
 *
 * 用于"失败后重跑只补建"：已存在就什么都不做，避免重复建。
 *
 * @param {string} owner 仓库所有者。
 * @param {string} repo 仓库名。
 * @param {string} tag 标签。
 * @returns {Promise<string | null>} 已存在时返回其 html_url，否则 null。
 */
async function findRelease(owner, repo, tag) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token === undefined || token === "") return null;
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) return null;
    const json = await response.json();
    return typeof json.html_url === "string" ? json.html_url : "exists";
  } catch {
    // 查不到就当不存在 —— 建 Release 是幂等的（tag 已存在时 GitHub 会附到该 tag）。
    return null;
  }
}

/**
 * 找某个 tag **之前**最近的 tag。
 *
 * @param {string} tag 当前 tag。
 * @returns {string} 上一个 tag；没有则返回仓库第一个提交。
 */
function previousTagBefore(tag) {
  try {
    const list = run(["git", "describe", "--tags", "--abbrev=0", `${tag}^`]);
    if (list !== "") return list;
  } catch {
    /* 没有更早的 tag */
  }
  try {
    const first = run(["git", "rev-list", "--max-parents=0", tag]).split("\n")[0];
    if (first !== undefined && first !== "") return first;
  } catch {
    /* 忽略 */
  }
  return tag;
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
    /*
     * ## 没有新提交时，可能仍需要**补建 Release**（2026-11-01 定版复核第 12 项）
     *
     * 发布分成"本地 → push → 建 Release"三段。若 tag 与 push 都成功、而建
     * Release 撞上临时 500 或网络错误：
     *
     * ```
     * 第一轮：tag/push 成功，Release 失败
     * 第二轮：next.level = none → 直接 return  ← 永远补不上
     * ```
     *
     * 结果是市场里只有 tag、没有更新说明，而重跑脚本没有任何帮助。
     *
     * 现在：没有新提交时检查**当前版本对应的 tag** —— 若 tag 存在但 Release
     * 不存在，就只补建，不再抬版本、不重复打 tag。
     */
    console.log("没有需要抬版本的提交。");
    if (dryRun) return;

    const currentTag = `v${next.current}`;
    let tagExists = false;
    try {
      tagExists = run(["git", "rev-parse", "--verify", `refs/tags/${currentTag}`]) !== "";
    } catch {
      tagExists = false;
    }
    if (!tagExists) {
      console.log(`${currentTag} 也不存在，没有可补建的对象。退出。`);
      return;
    }

    const info = packageInfo();
    const existing = await findRelease(info.owner, info.repo, currentTag);
    if (existing !== null) {
      console.log(`${currentTag} 的 Release 已存在（${existing}），无需补建。`);
      return;
    }

    console.log(`${currentTag} 的 tag 存在但 Release 缺失 —— 只补建 Release，不抬版本。`);
    /*
     * 提交说明用从上个 tag 到 `currentTag` 的范围。
     *
     * `currentTag` 自身就是终点，起点找它之前最近的 tag；找不到就用第一个提交。
     */
    const prev = previousTagBefore(currentTag);
    const commits = run([
      "git",
      "log",
      "--oneline",
      `${prev}..${currentTag}`,
    ])
      .split("\n")
      .filter((line) => line !== "" && !line.includes("chore(release)"))
      .map((line) => `- ${line.replace(/^[a-f0-9]+ /, "")}`)
      .join("\n");
    const body = note === "" ? commits : `${note}\n\n## 变更\n\n${commits}`;
    const backfill = await createRelease({
      owner: info.owner,
      repo: info.repo,
      tag: currentTag,
      title: currentTag,
      body,
    });
    console.log(`已补建 Release：${backfill}`);
    return;
  }
  console.log(`当前 ${next.current} → 下一个 ${next.next}（${next.level}）`);
  if (dryRun) return;

  /*
   * ## 上一个 tag 要带 `v` 前缀（2026-11-01 审查 SD-14 断点 3）
   *
   * `next.current` 是裸版本号（`1.8.4`），而仓库里的 tag 是 `v1.8.4`。
   * 拿裸版本号当 git ref 会 `unknown revision`。
   *
   * 先核实 `v<current>` 是否真的存在；不存在就留空（下面退回第一个提交）。
   */
  let prevTag = "";
  try {
    const candidate = `v${next.current}`;
    const verified = run(["git", "rev-parse", "--verify", `refs/tags/${candidate}`]);
    if (verified !== "") prevTag = candidate;
  } catch {
    prevTag = "";
  }

  // 2. 写版本号并重建产物（版本号是构建期注入的）。
  run(["node", "scripts/next-version.mjs", "--write"]);
  console.log("已写回 package.json");
  /*
   * ## 用当前 Node 可执行文件跑 pnpm，而不是裸命令（SD-14 断点 2）
   *
   * `execFileSync('pnpm', ...)` 在 Windows 上直接 ENOENT —— pnpm 是
   * `.cmd` 包装，`execFileSync` 不会像 shell 那样解析 PATHEXT。
   *
   * 复审在 Windows 上实测 npx / pnpm 入口均 ENOENT。
   *
   * 这里改用 `process.execPath` 跑 pnpm 的 JS 入口；找不到就退回
   * `shell: true`（由 shell 解析 `.cmd`）。两条路都比裸 `execFileSync` 稳。
   */
  runPnpm(["build"]);
  console.log("产物已重建");

  // 3. 全量验证：任何一步失败都不该发出去。
  //
  // 走 `pnpm exec` 而不是裸 `npx` —— 与 build 同样的跨平台理由（SD-14 断点 2）：
  // Windows 上 `npx` 是 `.cmd` 包装，`execFileSync` 直接 ENOENT。
  runPnpm(["exec", "tsc", "--noEmit"]);
  runPnpm(["exec", "vitest", "run"]);

  /*
   * ## 所有本地检查必须在**任何远程写**之前完成（SD-14）
   *
   * 下面这一段是全脚本唯一会改远端的地方。它之前的所有步骤
   * （算版本、重建、typecheck、test）都只影响本地。
   */
  // 4. 提交 + 打 tag + 推送。
  const tag = `v${next.next}`;
  run(["git", "add", "-A"]);
  run(["git", "commit", "-m", `chore(release): ${tag}`]);
  run(["git", "tag", tag]);
  run(["git", "push", "origin", "main", "--tags"]);
  console.log(`已推送 ${tag}`);

  // 5. 建 Release（市场靠它显示更新说明）。
  /*
   * ## 范围的两端都必须是**有效的 git ref**（2026-11-01 审查 SD-14 断点 3）
   *
   * 第一版是 `${next.current}..${tag}`，而 `next.current` 是裸版本号
   * （`1.8.4`），仓库里的 tag 却是 `v1.8.4`。于是：
   *
   * ```
   * git log 1.8.4..v1.10.1   → unknown revision   → 脚本崩溃
   * ```
   *
   * 而且这一行位于 `push` **之后** —— 崩在这里时远端已经有 tag，
   * 但 Release 没建，处于半途状态。
   *
   * 现在：起始 ref 用 `prevTag`（带 v 前缀、已核实存在），
   * 若没有上一个 tag 就用仓库的第一个提交。
   */
  const rangeStart = prevTag !== "" ? prevTag : run(["git", "rev-list", "--max-parents=0", "HEAD"]).split("\n")[0]
  const commits = run(["git", "log", "--oneline", `${rangeStart}..${tag}`])
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
