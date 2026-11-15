/**
 * 死锁自愈：被卡死在 evaluating 里的消息重新入队。
 *
 * 背景（2026-11-15 两次真实事故）：
 *  - 消息被并进活跃工单后 worker 判定「不是我的活」而 handback；
 *  - core/part.ts 的 handBack() 要求 !owners().length 才重新排队，而 model.ts:82 的
 *    followupOwners() 只要消息仍在 evaluating.triggerIds 里就返回空 —— 自指闭环，永不排队；
 *  - core/evals.ts:43 的超时又要求 evaluation.delivered 为真才生效，评估从未投递给
 *    router 时（delivered 缺省）deadline 永远不会到期。
 *  三者叠加即「Eval 空转、后续消息持续被吸入、界面无任何反应」，可从十几分钟挂到数小时。
 *
 * 本模块不改主包，只在插件层做外部自愈：扫 pane-log 的派活消息，凡是有 evalId 但
 * disposition.fanout 为空、且该 evalId 已超过阈值仍未产出 decision 的，调 engine.reevaluate
 * 重新入队。reevaluate 会标记 requeued，followupOwners 因此返回空，主 Session 的 accept
 * 不会再被 workerDecides 挡住。
 */

/** 扫描间隔；与其它自愈共用 30 秒节奏。 */
export const STUCK_SWEEP_MS = 30_000
/** Eval 超过这么久仍无 decision 即判定卡死。低于主包 120 s 的 evalTimeoutMs 会让正常评估反复重投，故取 5 分钟。 */
export const STUCK_EVAL_MS = 5 * 60_000
/** 消息本身的最大回溯年龄；更老的条目不再救援，避免重启时批量重投陈年消息。 */
export const STUCK_MAX_AGE_MS = 24 * 60 * 60_000
/** 每轮最多救援条数，避免一次把路由压垮。 */
export const STUCK_MAX_PER_SWEEP = 5
/** 每轮最多扫多少个对话的 pane-log。 */
export const STUCK_LOG_SCAN = 100
/** 写回原对话的提示文案。 */
export const STUCK_RECOVERED_TEXT = '这条消息一直卡在评估队列里没有落地，已自动重新交给路由器分诊。'

/** 判定一条派活消息是否卡死在 Eval 里；返回可救援时的时间戳，否则 undefined。 */
export function stuckSince (disposition: any, now: number): number | undefined {
  if (!disposition) return undefined
  // 已决定、已重投、已被接手的一律不动。
  if (disposition.decisionId || disposition.requeued || disposition.acked?.length) return undefined
  if (!disposition.evalId) return undefined
  // fanout 非空说明已进过工单，交给 recoverStranded 的既有规则处理。
  if (Array.isArray(disposition.fanout) && disposition.fanout.length) return undefined
  const at = Date.parse(String(disposition.at ?? ''))
  if (!Number.isFinite(at)) return undefined
  return now - at >= STUCK_EVAL_MS ? at : undefined
}

/** 一次扫描：把卡死的派活消息重新交给路由器。 */
export async function recoverStuck (host: {
  source: any
  store: any
  engine: any
  now: number
  appendLog: (source: any, conversation: string, entry: any) => void
  logger?: any
}): Promise<number> {
  const { source, store, engine, now, appendLog } = host
  if (!source?.state?.keys || typeof store?.triggers?.disposition !== 'function'
    || typeof engine?.reevaluate !== 'function') return 0
  const oldest = now - STUCK_MAX_AGE_MS
  let handled = 0
  const keys: string[] = [...(source.state.keys('pane-log:') ?? [])].slice(-STUCK_LOG_SCAN)
  for (const logKey of keys) {
    if (handled >= STUCK_MAX_PER_SWEEP) break
    const entries: any[] = source.state.get(logKey) ?? []
    for (let i = entries.length - 1; i >= 0 && handled < STUCK_MAX_PER_SWEEP; i--) {
      const entry = entries[i]
      try {
        if (entry?.direction !== 'in' || !['dispatch', 'assign'].includes(String(entry.mode))) continue
        const sentAt = entry.at ? Date.parse(entry.at) : Number.NaN
        if (!Number.isFinite(sentAt) || sentAt < oldest) continue
        const disposition = store.triggers.disposition(entry.id)
        if (stuckSince(disposition, now) === undefined) continue
        handled += 1
        if (engine.reevaluate(entry.id) !== true) continue
        const trigger = store.triggers.get?.(entry.id)
        const address = trigger?.channel?.address?.conversation
        const conversation = typeof address === 'string' && address ? address : logKey.slice('pane-log:'.length)
        appendLog(source, conversation, {
          id: `recovered-stuck:${entry.id}`, direction: 'out', at: new Date(now).toISOString(),
          text: STUCK_RECOVERED_TEXT, kind: 'recovered',
        })
        host.logger?.info?.('dsh-superagent-pane: 已救援卡死消息 %s（对话 %s）', entry.id, conversation)
      } catch (error) {
        host.logger?.warn?.('dsh-superagent-pane: 卡死消息检查失败 %s', String(error))
      }
    }
  }
  return handled
}
