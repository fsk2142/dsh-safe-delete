/**
 * `scripts/next-version.mjs` 的类型声明。
 *
 * 为什么需要：那个脚本是 `.mjs`（无类型），而 `tests/scripts/next-version.test.ts` 要 import
 * 它来测规则。没有这份声明，`tsc` 会报 TS7016（隐式 any）—— 那会让 `typecheck` 失败，
 * 也会让测试里的 `result.next` 之类的访问失去检查。
 */

/** `nextVersion()` 的入参。 */
export interface NextVersionOptions {
  /** 仓库目录。 */
  cwd: string;
}

/** `nextVersion()` 的结论。 */
export interface NextVersionResult {
  /** 当前版本（package.json 的 version）。 */
  current: string;
  /** 算出来的下一个版本。 */
  next: string;
  /** 抬的是哪一段：`major` / `minor` / `patch` / `none`。 */
  level: string;
  /** 每类提交的条数。 */
  counts: Record<string, number>;
  /** 统计到的提交总数。 */
  total: number;
  /** 统计起点（给人看的说明）。 */
  base: string;
  /** 是否因为没有可用的起点 tag 而统计了全部历史。 */
  wholeHistory: boolean;
}

/**
 * 按 conventional commits 算下一个版本号。
 * @param options - 仓库目录。
 * @returns 版本结论。
 */
export declare function nextVersion(options: NextVersionOptions): NextVersionResult;
