/**
 * 重复拦截升级。
 *
 * 模型是目标驱动的。被拦一次它会换姿势重试 —— 换个工具、改个写法、复制到别的目录
 * 再来一次。对于「它没读懂规则」这种情形，拒绝信息里的解释就够了；但对于
 * 「它不接受这个结论」，唯一有效的信号是明确的 STOP：把决定权交回人手上。
 *
 * 判定只按**目标路径**计数（不按命令文本），因为换个写法绕同一路径正是要防的行为。
 * 路径比较前统一小写，避免用大小写差异重置计数。
 */

/** 达到该次数后升级为 STOP。 */
const STOP_THRESHOLD = 3

/** 计数上限，防止长时间运行时 Map 无限增长。 */
const MAX_TRACKED = 500

const denials = new Map<string, number>()

/** 归一化被计数的主键。 */
function keyOf(target: string): string {
  return target.toLowerCase()
}

/** 清空计数（测试用，也用于「用户已介入」后的重置）。 */
export function resetDenials(): void {
  denials.clear()
}

/**
 * 记录一次拦截。
 *
 * @param target 被拦的目标（路径或命令摘要）。
 * @returns 该目标的累计拦截次数（含本次）。
 */
export function recordDenial(target: string): number {
  const key = keyOf(target)
  const next = (denials.get(key) ?? 0) + 1
  denials.set(key, next)

  // 简单容量保护：超过上限就丢掉最早写入的那些。
  if (denials.size > MAX_TRACKED) {
    const oldest = denials.keys().next()
    if (oldest.done !== true) denials.delete(oldest.value)
  }
  return next
}

/** 该目标是否已达到 STOP 阈值。 */
export function appliesStop(target: string): boolean {
  return (denials.get(keyOf(target)) ?? 0) >= STOP_THRESHOLD
}

/**
 * 追加到拒绝理由末尾的 STOP 条款。
 *
 * @param count 该目标已被拦截的次数。
 */
export function stopClause(count: number): string {
  return (
    `\n\nSTOP: this target has been blocked ${count} times. Do NOT try other tools, renamed paths, ` +
    `copied locations, or encoding tricks to get around the guard — that is exactly what it exists to stop. ` +
    `Explain the situation to the user and ask how they want to proceed.`
  )
}
