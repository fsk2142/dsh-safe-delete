//#region src/audit.d.ts
/**
 * 审计日志：把每次拦截、授权、删除、取回、清理都记下来。
 *
 * 为什么需要它：`safe_zone_list` 只回答"安全区里现在有什么"，回答不了
 * "昨天谁删了什么、当时为什么被拦"。出了问题要事后追查时，只有这份流水账能给答案。
 *
 * 格式：JSONL（一行一条），追加写。不读改，因此不会被并发写坏；读侧按行容错。
 */
/** 事件类型。 */
export type AuditEvent = 'delete' | 'restore' | 'prune' | 'block-shell' | 'block-write' | 'ask' | 'deny';
/** 一条审计记录。 */
export interface AuditRecord {
  at: string;
  event: AuditEvent;
  /** 相关路径。 */
  target?: string;
  /** 工具名。 */
  tool?: string;
  /** 补充说明（安全区 id、分类、原因等）。 */
  detail?: string;
}
/** 日志文件路径。 */
export declare function journalPath(stateDir: string): string;
/**
 * 追加一条审计记录。
 *
 * 刻意不抛错：审计写失败不该让一次删除失败 —— 那会让"记录"变成"功能"。
 */
export declare function appendAudit(stateDir: string, record: Omit<AuditRecord, 'at'> & {
  at?: string;
}): void;
/**
 * 追加一批审计记录：**一次文件操作写多行**。
 *
 * ## 为什么需要它
 *
 * 批量删除 1000 个文件时，`appendAudit` 逐条调用要 728 ms —— 占总耗时的一半以上，
 * 比实际移动（347 ms）还贵。原因是单条实现为了处理「上次写入留下半行」这个边界，
 * 每条都做 `existsSync + statSync + openSync + readSync + closeSync + appendFileSync`
 * 六次系统调用。
 *
 * 那个边界**每批只需要检查一次**：批量内部不会产生半行。所以这里先修一次，再把
 * 所有行拼成一个字符串一次写入。
 *
 * ## 与单条版本的关系
 *
 * 输出格式完全一致（每行一个 JSON）。`appendAudit` 仍保留，用于零散的单条写入
 * （拦截、取回、清理等，一次只有一条）。
 *
 * @param stateDir 安全区目录。
 * @param records 要写入的记录（可含 `at`，否则用当前时间）。
 */
export declare function appendAuditBatch(stateDir: string, records: Array<Omit<AuditRecord, 'at'> & {
  at?: string;
}>): void;
/**
 * 读取最近的审计记录。
 *
 * @param stateDir 安全区目录。
 * @param limit 最多返回多少条（最新的在前）。
 */
export declare function readAudit(stateDir: string, limit?: number): AuditRecord[];
//#endregion