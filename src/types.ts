/** 路径分级：自由 / 需确认 / 受保护。 */
export type Classification = 'free' | 'confirm' | 'protected'

/**
 * 一条删除命令的意图。
 *
 * `target` 为 `null` 表示「命令里有删除动作，但目标无法静态解析」（shell 变量、
 * 管道、通配符、命令替换）。这类情况不是要拒绝，而是要问人 —— 见 `parseCommand`。
 */
export interface DeleteIntent {
  kind: 'delete'
  recursive: boolean
  target: string | null
}

/** `parseCommand` 的判定结果。 */
export type CommandVerdict = { destructive: false } | ({ destructive: true } & DeleteIntent)

/** 安全区中的一条记录。 */
export interface TrashEntry {
  id: string
  originalPath: string
  movedAt: number
  expiresAt: number
  bytes: number
  fileCount: number
  isDirectory: boolean
  crossVolume: boolean
  reason?: string
}

/** 目标描述（`describeTarget` 的返回值）。 */
export interface TargetDescription {
  exists: boolean
  isDirectory: boolean
  bytes: number
  fileCount: number
  topEntries: string[]
  truncated: boolean
}
