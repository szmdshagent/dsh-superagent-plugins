/** Trigger ingestion, thread correlation, subscription fan-out, and evaluation queuing. */
import { key } from './ids.ts'
import { isoTime, liveTicket, threadKey } from './model.ts'
import type { Ticket, Trigger } from './model.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Tickets } from './tickets.ts'

export type ReceiveResult = 'stored' | 'duplicate' | 'filtered'

/**
 * Ingests incoming triggers from Sources, deduplicating and filtering them against SourceScope before recording thread correlations.
 * Fans listened triggers out to subscribed tickets via Tickets and queues for Eval, on its primary thread, every trigger no
 * ticket's worker decides (see `followupOwners`). An addressed message on a Thread several live tickets share, and an ended
 * ticket on a Thread another ticket subscribes to, reach no ticket (see `receive`).
 * Engine delegates trigger reception to this part.
 */
export class Intake extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets) { super(options) }

  receive(received: Trigger): ReceiveResult {
    // Normalize source timestamps (such as GitHub whole seconds) to canonical ISO form.
    const trigger = { ...received, at: isoTime(received.at) }
    if (!trigger.threads.length) throw new Error('A trigger must belong to at least one thread')
    if (this.repo.triggers.get(trigger.id)) return 'duplicate'
    const at = this.now()
    const filter = this.options.scope.scope(trigger)
    if (!filter.listened) {
      this.repo.triggers.save(trigger); this.repo.triggers.saveDisposition(trigger.id, { filtered: { code: filter.reason }, fanout: [], at })
      return 'filtered'
    }
    this.repo.triggers.save(trigger)
    const keys = trigger.threads.map(threadKey)
    // 先清掉指向已不存在工单的悬空订阅，再决定 fanout；已结束但记录仍在的订阅保留，人类追问仍可唤醒它。
    this.tickets.cleanSubscriptions(keys)
    // A person's addressed message on a Thread two or more live tickets make their own addresses all of them at once: it goes
    // to none of them and to Eval, where the main Session, which sees the Thread's tickets, attaches it or accepts new work.
    const ambiguous = trigger.human && trigger.addressed !== undefined && trigger.threads.some(ref => {
      const thread = this.thread(ref)
      return thread.subscriptions.filter(id => {
        const ticket = this.repo.tickets.get(id)
        return !!ticket && liveTicket(ticket) && !thread.context?.includes(id)
      }).length > 1
    })
    // Track reached tickets and whether they were reached only via context threads (a ticket's own thread makes `context` false).
    const reached = new Map<string, { ticket: Ticket; context: boolean }>()
    for (const ref of trigger.threads) {
      const thread = this.thread(ref)
      if (!thread.lastAt || trigger.at > thread.lastAt) thread.lastAt = trigger.at
      thread.correlated = [...new Set([...thread.correlated, ...keys.filter(other => other !== thread.key)])]
      for (const ticketId of ambiguous ? [] : thread.subscriptions) {
        const ticket = this.repo.tickets.get(ticketId)
        // Only a person's message on a non-context thread resumes an ended ticket; bots and CI do not (the Executor re-reads
        // threads when it resumes), and a human-stopped ticket receives nothing because its Mandate was withdrawn. A shared
        // thread is nobody's to resume on: once another ticket subscribes to it, the message waits for the main Session.
        // 悬空订阅已在上方清掉；这里再兜底一次，避免读到清理前抓到的 Thread 对象。
        if (!ticket) continue
        const followed = !!thread.context?.includes(ticketId)
        const sole = thread.subscriptions.every(id => id === ticketId || thread.context?.includes(id) || !this.repo.tickets.get(id))
        // 已结束单只为「人类追问」保留订阅：机器人/CI 消息直接跳过，不产生无效 fanout，也不唤醒。
        const resumes = trigger.human && ticket.ended?.by !== 'human' && !followed && sole
        if (!liveTicket(ticket) && !resumes) continue
        reached.set(ticketId, { ticket, context: followed && (reached.get(ticketId)?.context ?? true) })
      }
      this.repo.threads.save(thread)
    }
    for (const [ticketId, { ticket, context: followed }] of reached) {
      this.tickets.addInput(ticket, { id: key('input', ticketId, 'trigger', trigger.id), kind: 'trigger', triggerId: trigger.id, at,
        ...trigger.human ? { human: true } : {}, ...followed ? { context: true } : {} })
    }
    const fanout = [...reached.keys()], context = fanout.filter(id => reached.get(id)!.context)
    const disposition = { fanout, ...context.length ? { context } : {}, at }
    this.repo.triggers.saveDisposition(trigger.id, disposition)
    // A person's message that no ticket decides, such as one that reached only tickets a person stopped or that follow the
    // Thread for context, and every bot's, goes to Eval.
    if (!this.owners(trigger).length) this.queueForEval(trigger)
    for (const ticketId of fanout) this.tickets.wake(ticketId)
    this.emit('trigger.received', { triggerId: trigger.id, threads: trigger.threads.map(threadKey) })
    return 'stored'
  }
}
