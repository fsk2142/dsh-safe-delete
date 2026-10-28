import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
//#region src/describe.ts
/**
* 描述一个待删除目标：它是什么、多大、里面有什么。
*
* 这是「删之前让你看清」的依据，也是审批卡片上那行文字的来源。
*
* 实现约束：
*   - 不抛错：权限被拒、链接损坏都只跳过，不能让描述失败挡住一次删除判定。
*   - 不跟随符号链接：避免链接环导致无限递归。
*   - 顶层条目排序：输出稳定，测试才能断言。
*/
/** 顶层条目最多列多少个。 */
const MAX_TOP_ENTRIES = 20;
/** 递归遍历时最多访问多少个条目，防止超大目录拖死事件循环。 */
const MAX_WALK_ENTRIES = 2e5;
/**
* 递归累加目录的大小与文件数。
*/
function walk(dir, acc) {
	if (acc.fileCount > MAX_WALK_ENTRIES) return;
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const full = path.join(dir, name);
		let st;
		try {
			st = lstatSync(full);
		} catch {
			continue;
		}
		if (st.isSymbolicLink()) {
			acc.fileCount += 1;
			continue;
		}
		if (st.isDirectory()) {
			walk(full, acc);
			continue;
		}
		acc.bytes += st.size;
		acc.fileCount += 1;
	}
}
/**
* 描述一个路径。
*
* @param absPath 目标绝对路径。
*/
function describeTarget(absPath) {
	let st;
	try {
		st = statSync(absPath);
	} catch {
		return {
			exists: false,
			isDirectory: false,
			bytes: 0,
			fileCount: 0,
			topEntries: [],
			truncated: false
		};
	}
	if (!st.isDirectory()) return {
		exists: true,
		isDirectory: false,
		bytes: st.size,
		fileCount: 1,
		topEntries: [],
		truncated: false
	};
	const acc = {
		bytes: 0,
		fileCount: 0
	};
	walk(absPath, acc);
	let names = [];
	try {
		names = readdirSync(absPath).sort();
	} catch {
		names = [];
	}
	return {
		exists: true,
		isDirectory: true,
		bytes: acc.bytes,
		fileCount: acc.fileCount,
		topEntries: names.slice(0, MAX_TOP_ENTRIES),
		truncated: names.length > MAX_TOP_ENTRIES
	};
}
//#endregion
//#region src/recycle.ts
/**
* 把安全区里过期的条目移入**系统回收站**，而不是永久删除。
*
* ## 为什么需要这一层
*
* 安全区和系统回收站是**两道**防线，不该合并：
*
* | 层 | 谁触发 | 谁能挽回 |
* |---|---|---|
* | 安全区 | 删除那一刻（自动） | 保留期内用 `safe_zone_restore` |
* | 系统回收站 | 保留期结束（自动） | 用户手动清空之前都能还原 |
* | 永久删除 | 用户清空回收站（手动） | 没有了 |
*
* 如果安全区过期时直接 `rmSync`，就等于把「自动」这一步升级成了最终删除 ——
* 用户对这两步的心理预期完全不同：清理回收站是他主动做的决定，而安全区的
* 定时清理是无人值守的。
*
* ## 失败时的行为
*
* **绝不静默降级成永久删除。** 移入回收站失败时：
*   - 返回失败原因；
*   - 调用方应把该条目留在安全区（而不是删掉）；
*   - 由 `safe_zone_status` 报告「清理被跳过」，让人自己决定。
*
* 宁可占着磁盘，也不能在用户不知情的情况下永久抹掉数据。
*/
/**
* 判断当前平台是否支持「移入回收站」。
*
* @returns 支持的平台返回 `true`。
*/
function canRecycle() {
	return process.platform === "win32" || process.platform === "darwin" || process.platform === "linux";
}
/** 调用外部命令的统一超时（毫秒）。 */
const COMMAND_TIMEOUT_MS = 2e4;
/**
* 连续失败多少次后熔断。
*
* 为什么需要：`moveToSystemRecycleBin` 是**同步阻塞**调用（`execFileSync`），
* 而且跑在索引串行队列里。如果系统 shell 出了毛病（COM 损坏、超大文件触发
* 系统确认对话框），每个条目都可能耗掉 20 秒，一次清理 N 个条目就会卡 N×20 秒，
* 期间所有并发的安全区操作都在排队。
*
* 连续 3 次失败基本可以断定是环境问题而不是偶发，此时熔断：剩下的条目直接
* 判定为「跳过」，让调用方带着「回收站不可用」的结果立刻返回，而不是逐个等超时。
*/
const FAILURE_BREAKER_THRESHOLD = 3;
/** 当前连续失败次数（进程内）。成功一次就归零。 */
let consecutiveFailures = 0;
/**
* 回收站是否已被熔断。
*
* @returns 连续失败达到阈值时返回 `true`。
*/
function recycleIsTripped() {
	return consecutiveFailures >= FAILURE_BREAKER_THRESHOLD;
}
/**
* 记录一次失败的回收尝试。
*
* 抽成函数是为了让**跳闸路径本身**可以被测试直接驱动：真实失败需要 shell 出问题，
* 测试无法可靠制造那种环境。生产代码也走这里，所以测的不是影子逻辑。
*
* @returns 记录之后的连续失败次数。
*/
function recordRecycleFailure() {
	consecutiveFailures += 1;
	return consecutiveFailures;
}
/**
* 把一个路径移入系统回收站。
*
* @param absPath 要移入的绝对路径（文件或目录）。
* @returns 结果；失败时带原因，调用方**不可**据此永久删除。
*/
function moveToSystemRecycleBin(absPath) {
	if (recycleIsTripped()) return {
		ok: false,
		reason: `recycle bin unavailable after ${consecutiveFailures} consecutive failures; entries stay in the safe zone. Restart DSH to retry.`
	};
	if (!existsSync(absPath)) return {
		ok: false,
		reason: `path does not exist: ${absPath}`
	};
	const outcome = attemptRecycle(absPath);
	if (outcome.ok) consecutiveFailures = 0;
	else recordRecycleFailure();
	return outcome;
}
/**
* 真正尝试一次回收（不含熔断判定）。
*
* @param absPath 绝对路径。
* @returns 结果。
*/
function attemptRecycle(absPath) {
	try {
		if (process.platform === "win32") return recycleOnWindows(absPath);
		if (process.platform === "darwin") return recycleOnMac(absPath);
		if (process.platform === "linux") return recycleOnLinux(absPath);
		return {
			ok: false,
			reason: `unsupported platform: ${process.platform}`,
			unsupported: true
		};
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error)
		};
	}
}
/**
* Windows：用 Shell.Application 的 `delete` 动词。
*
* 为什么不用 `Remove-Item`：那个是永久删除（或进回收站，取决于文件大小与配置），
* 行为不确定。Shell 的 delete 动词明确走回收站。
*
* @param absPath 绝对路径。
* @returns 结果。
*/
function recycleOnWindows(absPath) {
	/**
	* 关键：`Namespace(0).ParseName(完整路径)` 对深层路径**不可靠** —— 实测它会返回
	* 一个 item，但 `InvokeVerb('delete')` 变成永久删除而不是进回收站。
	*
	* 更稳的做法是像资源管理器一样：先 `Namespace('父目录')`，再 `ParseName('文件名')`。
	* 这样拿到的是真实的 shell 项目，delete 动词才会走回收站。
	*/
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"$shell = New-Object -ComObject Shell.Application",
		`$folder = $shell.Namespace('${absPath.replace(/'/g, "''").replace(/\\[^\\]+$/, "")}')`,
		"if ($null -eq $folder) { Write-Error 'NO_PARENT_FOLDER'; exit 1 }",
		`$item = $folder.ParseName('${absPath.replace(/^.*[\\/]/, "").replace(/'/g, "''")}')`,
		"if ($null -eq $item) { Write-Error 'NO_ITEM'; exit 1 }",
		"$item.InvokeVerb('delete')",
		"exit 0"
	].join("; ");
	try {
		execFileSync("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			script
		], {
			timeout: COMMAND_TIMEOUT_MS,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
	} catch (error) {
		return {
			ok: false,
			reason: `Shell.Application delete failed: ${error instanceof Error ? error.message : String(error)}`
		};
	}
	waitForGone(absPath, 3e3);
	if (existsSync(absPath)) return {
		ok: false,
		reason: "Shell.Application returned but the path still exists (may need confirmation)"
	};
	return { ok: true };
}
/**
* macOS：用 Finder 的 delete，等价于「移到废纸篓」。
*
* @param absPath 绝对路径。
* @returns 结果。
*/
function recycleOnMac(absPath) {
	const escaped = absPath.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
	try {
		execFileSync("osascript", ["-e", `tell application "Finder" to delete POSIX file "${escaped}"`], {
			timeout: COMMAND_TIMEOUT_MS,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
	} catch (error) {
		return {
			ok: false,
			reason: `Finder delete failed: ${error instanceof Error ? error.message : String(error)}`
		};
	}
	waitForGone(absPath, 3e3);
	return existsSync(absPath) ? {
		ok: false,
		reason: "Finder returned but the path still exists"
	} : { ok: true };
}
/**
* Linux：优先 `gio trash`（GNOME/现代发行版都有），退回 `trash-put`。
*
* @param absPath 绝对路径。
* @returns 结果。
*/
function recycleOnLinux(absPath) {
	const attempts = [["gio", ["trash", absPath]], ["trash-put", [absPath]]];
	let lastReason = "no trash command available (tried gio, trash-put)";
	for (const [command, args] of attempts) try {
		execFileSync(command, args, {
			timeout: COMMAND_TIMEOUT_MS,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		waitForGone(absPath, 3e3);
		if (!existsSync(absPath)) return { ok: true };
		lastReason = `${command} returned but the path still exists`;
	} catch (error) {
		lastReason = `${command} failed: ${error instanceof Error ? error.message : String(error)}`;
	}
	return {
		ok: false,
		reason: lastReason
	};
}
/**
* 等待路径消失，最多等 `timeoutMs`。
*
* 为什么需要：系统回收站调用是异步的（Shell 把请求投递给资源管理器），
* 命令返回时文件往往还在原处。立刻判定会得到假失败。
*
* @param absPath 路径。
* @param timeoutMs 最长等待。
*/
function waitForGone(absPath, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!existsSync(absPath)) return;
		const buffer = new SharedArrayBuffer(4);
		Atomics.wait(new Int32Array(buffer), 0, 0, 100);
	}
}
//#endregion
//#region src/store.ts
/**
* 安全区：被删除内容的暂存处，也是本插件唯一会移动用户数据的地方。
*
* 布局：
*   <stateDir>/items/<id>/   被移入的内容
*   <stateDir>/index.json    条目索引
*
* 两条硬约束：
*   1. **移入用 rename**（同卷 O(1)，不复制、不占额外空间）。跨卷时 `rename`
*      抛 `EXDEV`；在 `crossVolumeCopy` 为假（默认）时明确拒绝，绝不静默降级为
*      「复制后删源」那种看起来成功、实则多一份拷贝的行为。
*   2. **唯一允许递归删除的地方是 `destroyEntry`**，且只针对安全区内部路径。
*      除此之外本文件不删任何用户数据。
*/
const INDEX_FILE = "index.json";
const ITEMS_DIR = "items";
/** 保留天数的硬边界。与表单、斜杠命令的取值范围保持一致。 */
const RETENTION_MIN_DAYS = 1;
const RETENTION_MAX_DAYS = 365;
/**
* 把保留天数收进安全区间。
*
* ## 为什么在消费处也要钳
*
* 表单（`client/index.tsx`）和斜杠命令（`settings-guide.ts`）都限制 1–365 天，
* 但**配置文件可以手改**。上游的校验不是数据完整性的最后一道关口。
*
* 不钳的后果有两级，都不是「保留更久」那么轻：
*
* 1. **`retentionDays: 0` 或负数** → `expiresAt` 落在过去 → 条目刚删进去就被判定
*    过期，下一轮清理直接进回收站。用户以为有保留期，实际没有。
* 2. **极大值** → `Date.now() + 1e8 * 86400000` 超出 Date 可表示范围，得到
*    `Invalid Date`。而 `expiresAt <= now` 对 `NaN` 恒为 false，于是该条目
*    **永远不会被清理**，且不报任何错。
*
* 两种情况都是静默的。所以钳制放在真正写 `expiresAt` 的地方，而不是只放在入口。
*
* @param days 上游给的天数（可能非法）。
* @returns 落在 `[1, 365]` 内的整数天数。
*/
function clampRetentionDays(days) {
	if (!Number.isFinite(days)) return RETENTION_MIN_DAYS;
	const whole = Math.round(days);
	if (whole < RETENTION_MIN_DAYS) return RETENTION_MIN_DAYS;
	if (whole > RETENTION_MAX_DAYS) return RETENTION_MAX_DAYS;
	return whole;
}
/** 索引路径。 */
function indexPath(stateDir) {
	return path.join(stateDir, INDEX_FILE);
}
/** 条目内容目录。 */
function entryDir(stateDir, id) {
	return path.join(stateDir, ITEMS_DIR, id);
}
/**
* 把内容搬回原处、再收掉刚建的 `items/<id>` 目录。
*
* ## 为什么需要它
*
* `moveToSafeZone` 的顺序是：建目录 → 移动内容（rename）→ 写索引。**第三步失败**
* 时，前两步已经成功：内容真的被移进了 `items/<id>/`，而索引里没有记录指向它。
*
* 此时如果只 `rmdir`（空目录才行）就会失败，目录连同**用户的数据**一起变成孤儿：
* 清理逻辑只遍历索引，所以它既不会被自动清理，也不会出现在 `safe_zone_list` 里
* —— 用户以为文件还在安全区，其实已经"失联"了。
*
* 实测踩到过：一次清理后留下 3 个孤儿目录，`safe_zone_status` 报 87 条而磁盘上
* 有 90 个目录。
*
* ## 正确的补救顺序
*
* 1. 先把内容**搬回原路径**（`renameSync` 回去），让用户的数据回到原位；
* 2. 再删掉现在（应当）已空的 `items/<id>`；
* 3. 任何一步失败都**只记录不抛**——不能覆盖原始的索引错误。
*
* 关键取舍：**宁可不删目录，也不能删掉里面的数据**。所以只有确认搬回成功（或
* 目录本来就空）才 `rmdir`；如果搬不回去，目录留着 —— 至少数据还在盘上，
* 用户手动也能捞出来。
*
* @param entryRoot 条目目录。
* @param dest 内容实际落点（`entryRoot/<basename>`）。
* @param target 原始路径。
*/
function rollbackEntry(entryRoot, dest, target) {
	try {
		if (existsSync(dest) && !existsSync(target)) renameSync(dest, target);
	} catch {}
	try {
		rmdirSync(entryRoot);
	} catch {}
}
/**
* 索引写操作的串行队列。
*
* ## 为什么需要
*
* `moveToSafeZone` / `destroyEntry` / `restoreFromSafeZone` 都是
* 「读索引 → 改 → 写回」。DSH 的并发工具调用可达 50，两个并发的删除会读到同一份
* 旧数组，后写者把它整个覆盖回去 —— 前一条从索引里消失，但内容还留在
* `items/<id>/` 盘上。后果是**列表看不见、清理永远轮不到**（prune 只扫索引），
* 属于静默的磁盘泄漏。
*
* ## 为什么用 Promise 链而不是文件锁
*
* 插件跑在单个宿主进程里，跨进程并发不存在。一条 Promise 链就够，而且
* 没有锁文件残留、崩溃自动释放的问题。
*/
let indexQueue = Promise.resolve();
/**
* 把一次索引操作排进队列，保证读-改-写不交错。
*
* @param job 要串行执行的操作。
* @returns 该操作的结果。
*/
function serialized(job) {
	const run = indexQueue.then(job, job);
	indexQueue = run.then(() => void 0, () => void 0);
	return run;
}
/** 读索引；不存在或损坏时返回空数组（安全区宁可"看起来空"也不能让删除流程崩掉）。 */
async function readIndex(stateDir) {
	const file = indexPath(stateDir);
	if (!existsSync(file)) return [];
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (!Array.isArray(parsed)) return [];
		return parsed;
	} catch {
		return [];
	}
}
/**
* 原子写索引：先写临时文件再 rename，避免中途崩溃留下半个 JSON。
*/
async function writeIndex(stateDir, entries) {
	mkdirSync(stateDir, { recursive: true });
	const file = indexPath(stateDir);
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
	renameSync(tmp, file);
}
/**
* 按条件筛选后写索引：**调用方已经持有索引内容**，这里不重新读。
*
* ## 为什么单独暴露
*
* 批量清理（`pruneNow`）需要"读一次索引、处理 N 条内容、写一次索引"。如果每条
* 都走 `destroyEntry`，就会变成 N 次全量读 + N 次全量写（O(N²)，实测 3000 条
* 要 12.9 秒）。这个函数让调用方自己控制读写的次数。
*
* 与 `writeIndex` 的唯一区别是它在串行队列里执行 —— 批量路径必须和单条路径
* 共享同一把锁，否则两边同时写会把索引写坏。
*
* @param stateDir 安全区根目录。
* @param current 调用方已读到的索引快照。
* @param keep 保留谓词；返回 false 的条目会被移除。
*/
async function writeIndexFiltered(stateDir, current, keep) {
	return serialized(async () => {
		await writeIndex(stateDir, current.filter(keep));
	});
}
/**
* 只处理一个条目的**内容**（回收站或丢弃），不碰索引。
*
* 与 `destroyEntry` 的区别：那个连索引一起改，所以每条都要读全量 + 写全量。
* 批量清理只在这一步逐条调用，索引由调用方最后写一次。
*
* ## 安全约束照旧
*
* 路径必须落在 `items/` 之下（双保险，即使索引被篡改也不越界）；
* 内容已经不存在时视为成功（只差清索引）；
* recycler 抛错或失败时**保留内容**并返回原因 —— 绝不因为回收站坏了就永久删。
*
* @param stateDir 安全区根目录。
* @param id 条目 id。
* @param options 是否永久删除、替换的回收实现。
* @returns 成功时给出方式；失败时给出原因（内容仍在磁盘上）。
*/
async function discardEntryContent(stateDir, id, options = {}) {
	const dir = entryDir(stateDir, id);
	if (!isUnder(dir, path.join(stateDir, ITEMS_DIR))) throw new Error(`refusing to destroy a path outside the safe zone: ${dir}`);
	if (!existsSync(dir)) return {
		ok: true,
		via: "permanent"
	};
	if (options.permanent === true) {
		rmSync(dir, {
			recursive: true,
			force: true
		});
		return {
			ok: true,
			via: "permanent"
		};
	}
	const recycler = options.recycler ?? moveToSystemRecycleBin;
	let outcome;
	try {
		outcome = recycler(dir);
	} catch (error) {
		outcome = {
			ok: false,
			reason: error instanceof Error ? error.message : String(error)
		};
	}
	if (!outcome.ok) return {
		ok: false,
		reason: outcome.reason
	};
	return {
		ok: true,
		via: "recycle"
	};
}
/** 生成一个可读且不冲突的 id。 */
function makeId(now) {
	const d = new Date(now);
	const pad = (n, width = 2) => String(n).padStart(width, "0");
	return `${`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`}-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
}
/** `child` 是否在 `parent` 之内（按分隔符边界）。 */
function isUnder(child, parent) {
	const c = path.resolve(child);
	const p = path.resolve(parent);
	if (c === p) return true;
	return c.startsWith(p + path.sep);
}
/**
* 把内容搬进安全区并返回索引条目，**但不写索引**。
*
* 抽出来的目的：批量删除时一批只写一次索引。逐条写时每一条都要重写整个
* `index.json`（删第 N 条时文件已有 N-1 条），总成本 O(N²) —— 1000 个文件
* 实测在数秒级（4–6 秒，随索引大小与磁盘而异）。合并后同一批只要约 0.4 秒。
*
* ## 调用方的责任
*
* 拿到返回值后**必须**把它并进索引（`moveToSafeZone` 或 `moveManyToSafeZone`
* 都会做）。如果调用方忘了，就会出现「磁盘上有内容、索引里没记录」的孤儿 ——
* 清理逻辑只遍历索引，那些目录永远清不掉。
*
* @param stateDir 安全区根目录。
* @param absPath 要移入的路径。
* @param opts 保留期与跨卷策略。
* @returns 索引条目。
*/
async function stageInto(stateDir, absPath, opts) {
	const target = path.resolve(absPath);
	if (isUnder(stateDir, target) || isUnder(target, stateDir)) throw new Error(`refusing to move the safe zone itself (${target}) into the safe zone`);
	const now = opts.now ?? Date.now();
	const description = describeTarget(target);
	if (!description.exists) throw new Error(`not found: ${target}`);
	const id = makeId(now);
	const entryRoot = entryDir(stateDir, id);
	const dest = path.join(entryRoot, path.basename(target));
	mkdirSync(entryRoot, { recursive: true });
	let crossVolume = false;
	try {
		renameSync(target, dest);
	} catch (error) {
		if (error.code !== "EXDEV") {
			rollbackEntry(entryRoot, dest, target);
			throw error;
		}
		if (opts.crossVolumeCopy !== true) {
			rollbackEntry(entryRoot, dest, target);
			throw new Error(`cannot move "${target}" into the safe zone: they are on different volumes. Move the safe zone to the same volume, or enable crossVolumeCopy to copy instead.`);
		}
		crossVolume = true;
		cpSync(target, dest, {
			recursive: true,
			preserveTimestamps: true
		});
	}
	return {
		id,
		originalPath: target,
		movedAt: now,
		expiresAt: now + clampRetentionDays(opts.retentionDays) * 24 * 60 * 60 * 1e3,
		bytes: description.bytes,
		fileCount: description.fileCount,
		isDirectory: description.isDirectory,
		crossVolume,
		...opts.reason !== void 0 && opts.reason !== "" ? { reason: opts.reason } : {}
	};
}
/**
* 把一个路径移入安全区。
*
* @param stateDir 安全区根目录。
* @param absPath 要移入的绝对路径。
* @param opts 保留期与跨卷策略。
* @returns 新条目。
*/
async function moveToSafeZone(stateDir, absPath, opts) {
	return serialized(async () => {
		const entry = await stageInto(stateDir, absPath, opts);
		const entries = await readIndex(stateDir);
		entries.push(entry);
		try {
			await writeIndex(stateDir, entries);
		} catch (error) {
			const root = entryDir(stateDir, entry.id);
			if (entry.crossVolume) try {
				rmSync(root, {
					recursive: true,
					force: true
				});
			} catch {}
			else rollbackEntry(root, path.join(root, path.basename(entry.originalPath)), entry.originalPath);
			throw error;
		}
		if (entry.crossVolume) rmSync(entry.originalPath, {
			recursive: true,
			force: true
		});
		return entry;
	});
}
/**
* 批量移入：所有成功项**只在最后写一次索引**。
*
* ## 为什么
*
* `moveToSafeZone` 每调用一次就重写整个 `index.json`。删 1000 个文件时索引会
* 从 0 涨到 1000 条，累计重写量是 O(N²)，实测在数秒级（4–6 秒）。这里改成一次。
*
* ## 失败语义没变
*
* - 单条失败只影响那一条，其余照常；
* - 有失败时仍然把**成功的那些**写进索引（否则它们的磁盘内容就成了孤儿）；
* - 一条都没成功就不写索引（避免无意义的空写）。
*
* ## 与 `moveToSafeZone` 的关系
*
* 两者共用 `stageInto`，所以分级判定、回滚、跨卷策略完全一致 —— 这里只是把
* 「写索引」这一步提到了循环外面。
*
* @param stateDir 安全区根目录。
* @param absPaths 要移入的路径列表。
* @param opts 保留期与跨卷策略。
* @returns 每条的结果（成功带条目，失败带原因）。
*/
async function moveManyToSafeZone(stateDir, absPaths, opts) {
	return serialized(async () => {
		const results = [];
		const staged = [];
		for (const p of absPaths) try {
			const entry = await stageInto(stateDir, p, opts);
			staged.push(entry);
			results.push({
				path: p,
				entry
			});
		} catch (error) {
			results.push({
				path: p,
				error: error instanceof Error ? error.message : String(error)
			});
		}
		if (staged.length === 0) return results;
		const entries = await readIndex(stateDir);
		entries.push(...staged);
		try {
			await writeIndex(stateDir, entries);
		} catch (error) {
			for (const entry of staged) {
				const root = entryDir(stateDir, entry.id);
				if (entry.crossVolume) try {
					rmSync(root, {
						recursive: true,
						force: true
					});
				} catch {}
				else rollbackEntry(root, path.join(root, path.basename(entry.originalPath)), entry.originalPath);
			}
			throw error;
		}
		for (const entry of staged) if (entry.crossVolume) rmSync(entry.originalPath, {
			recursive: true,
			force: true
		});
		return results;
	});
}
/** 列出安全区条目（按移入时间升序）。 */
async function listSafeZone(stateDir) {
	return [...await readIndex(stateDir)].sort((a, b) => a.movedAt - b.movedAt);
}
/**
* 从安全区还原一条。
*
* 原路径已被占用时还原到同级 `.restored-<时间戳>` 兄弟 —— 绝不覆盖现在的文件。
*/
async function restoreFromSafeZone(stateDir, id) {
	return serialized(async () => {
		const entries = await readIndex(stateDir);
		const entry = entries.find((e) => e.id === id);
		if (entry === void 0) throw new Error(`unknown safe-zone id: ${id}`);
		const source = resolveStoredContent(stateDir, id);
		if (source === null) throw new Error(`safe-zone entry ${id} has no content on disk`);
		let destination = entry.originalPath;
		if (existsSync(destination)) {
			const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
			destination = `${entry.originalPath}.restored-${stamp}`;
		}
		mkdirSync(path.dirname(destination), { recursive: true });
		try {
			renameSync(source, destination);
		} catch (error) {
			if (error.code !== "EXDEV") throw error;
			cpSync(source, destination, {
				recursive: true,
				preserveTimestamps: true
			});
			rmSync(source, {
				recursive: true,
				force: true
			});
		}
		try {
			rmSync(entryDir(stateDir, id), {
				recursive: true,
				force: true
			});
		} catch {}
		await writeIndex(stateDir, entries.filter((e) => e.id !== id));
		return { restoredTo: destination };
	});
}
/**
* 找出某条目实际存放内容的位置。
*
* 兼容两种布局：`items/<id>/<basename>`（当前）与 `items/<id>` 本身（早期版本）。
*
* @returns 内容路径；条目为空或缺失时返回 `null`。
*/
function resolveStoredContent(stateDir, id) {
	const root = entryDir(stateDir, id);
	if (!existsSync(root)) return null;
	let names;
	try {
		names = readdirSync(root);
	} catch {
		return null;
	}
	if (names.length === 0) return null;
	if (names.length === 1) return path.join(root, names[0]);
	return root;
}
/**
* 销毁一条：**优先移入系统回收站**，只有明确要求时才永久抹掉。
*
* ## 为什么不是直接 rmSync
*
* 安全区和系统回收站是两道防线：
*
*   删除 → 安全区（保留期内 `safe_zone_restore` 可取回）
*        → 到期 → 系统回收站（用户清空之前都能还原）
*        → 用户手动清空回收站 → 才真正消失
*
* 如果这里直接 `rmSync`，就把「自动过期」升级成了最终删除 —— 而安全区的定时
* 清理是**无人值守**的，不该替用户做这个决定。
*
* ## 失败时不删除
*
* 移入回收站失败（权限、系统组件缺失、路径被占用）时，条目**留在安全区**并把
* 原因返回给调用方，由 `safe_zone_status` 报告。宁可占磁盘，也不能静默永久删除。
*
* @param stateDir 安全区根目录。
* @param id 条目 id。
* @param options `permanent: true` 时才真正 rmSync（用于「清空安全区」这类明示操作）；
*   `recycler` 可替换回收站实现（测试用替身，生产路径不传）。
* @returns 结果；失败时附带原因，条目未被删除。
*/
async function destroyEntry(stateDir, id, options = {}) {
	return serialized(async () => {
		const entries = await readIndex(stateDir);
		if (entries.find((e) => e.id === id) === void 0) throw new Error(`unknown safe-zone id: ${id}`);
		const dir = entryDir(stateDir, id);
		if (!isUnder(dir, path.join(stateDir, ITEMS_DIR))) throw new Error(`refusing to destroy a path outside the safe zone: ${dir}`);
		if (!existsSync(dir)) {
			await writeIndex(stateDir, entries.filter((e) => e.id !== id));
			return {
				ok: true,
				via: "permanent"
			};
		}
		let via = "permanent";
		if (options.permanent !== true) {
			const recycler = options.recycler ?? moveToSystemRecycleBin;
			let outcome;
			try {
				outcome = recycler(dir);
			} catch (error) {
				outcome = {
					ok: false,
					reason: error instanceof Error ? error.message : String(error)
				};
			}
			if (!outcome.ok) return {
				ok: false,
				reason: outcome.reason
			};
			via = "recycle";
		} else rmSync(dir, {
			recursive: true,
			force: true
		});
		await writeIndex(stateDir, entries.filter((e) => e.id !== id));
		return {
			ok: true,
			via
		};
	});
}
/** 安全区是否为空（含磁盘上无残留条目）。 */
async function isEmptySafeZone(stateDir) {
	if ((await readIndex(stateDir)).length > 0) return false;
	const items = path.join(stateDir, ITEMS_DIR);
	if (!existsSync(items)) return true;
	try {
		return readdirSync(items).length === 0;
	} catch {
		return true;
	}
}
//#endregion
export { moveManyToSafeZone as a, writeIndexFiltered as c, listSafeZone as i, canRecycle as l, discardEntryContent as n, moveToSafeZone as o, isEmptySafeZone as r, restoreFromSafeZone as s, destroyEntry as t, describeTarget as u };
