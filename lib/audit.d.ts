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
 * 读取最近的审计记录。
 *
 * @param stateDir 安全区目录。
 * @param limit 最多返回多少条（最新的在前）。
 */
export declare function readAudit(stateDir: string, limit?: number): AuditRecord[];
//#endregion