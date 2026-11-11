/** Tickets: their lifecycle from an accept to their end, their Subscriptions and their Inputs. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, latestReport, liveTicket, readUntil, runningAssignment, settled, threadKey, waitsForPerson } from './model.ts'
import type { Assignment, ChannelRef, CollaborationInput, Evaluation, Follow, Mandate, PolicyEffect, ReportState, ThreadRef, Ticket,
  TicketEndBy, TicketInput, TicketOutcome, Trigger, TriggerDisposition } from './model.ts'
import type { AssessmentOutcome } from './ports.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Replies } from './replies.ts'
import { matchResultCards, resultCardNote } from './results.ts'
import { ACTIVITY_MS, AUTO_GROUP_TTL_MS, UNRELATED, collabView, planAutoGroup } from './collab-auto.ts'
import type { AutoCandidate, CandidateGroup } from './collab-auto.ts'
import { canRetry } from './stage.ts'

const sameChannel = (a: ChannelRef, b: ChannelRef): boolean => JSON.stringify(a) === JSON.stringify(b)
/** Whether an Input is a message no person wrote, such as CI's, a bot's, or the main Session's note. */
export const automatic = (input: TicketInput | undefined): boolean => input?.kind === 'note' || (input?.kind === 'trigger' && !input.human)
/**
 * Whether a ticket's worker read a Trigger Input before `until`, its latest report or turn end: its Session took the message
 * into a step before then. One delivered before reads were recorded counts as read once it reached the worker by then.
 */
const readBefore = (input: Extract<TicketInput, { kind: 'trigger' }>, until: string): boolean => input.readAt === undefined
  ? (input.deliveredAt && input.deliveredAt > input.at ? input.deliveredAt : input.at) <= until : !!input.readAt && input.readAt < until
const STATUS_REQUEST = 'Report the current ticket status with orchestrator_report. This is a status-only request: do not resume implementation or perform external actions.'
/** 协作组上限：联系人手一屏能看完，也限制并发放大的成本。 */
const GROUP_LIMIT = 4
/** 会广播给同组的报告终态；progress、waiting 和 dropped 不广播（dropped 是空转，不是可复用结果）。 */
const SHARED_REPORTS: ReadonlySet<ReportState> = new Set(['ready', 'blocked', 'failed'])

/**
 * Manages each ticket's lifecycle: creates the ticket for an accept decision with its Mandate, Subscriptions, and first
 * Assignment, binds and attaches Threads, adds Inputs, resumes, retries, restarts, and ends tickets, and drops Subscriptions.
 * Coordinates with Replies for the acknowledgement an accept carries and with Executor to start, deliver to, and stop assignments.
 * Intake, Evals, Assignments, and Engine delegate ticket and subscription mutations here.
 */
export class Tickets extends EnginePart {
  constructor(options: EngineOptions, private readonly replies: Replies) { super(options) }

  /**
   * Create the ticket an accept decided, under `mandate`, with the Channels and Threads of the Eval's Triggers, its first
   * Assignment, and the acknowledgement the accept carries, and queue its launch. Its origin is the admissible Trigger that
   * gave the Eval its strength, or the Eval's last Trigger for an Eval recorded before `primary` existed.
   */
  create(id: string, decisionId: string, mandate: Mandate, evaluation: Pick<Evaluation, 'triggerIds' | 'primary'>,
    outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, at: string): void {
    const { triggerIds } = evaluation
    // Fall back to the last trigger for Evals recorded before `primary` existed.
    const primary = this.repo.triggers.get(evaluation.primary ?? triggerIds.at(-1)!)
    const origin = { triggerId: primary?.id ?? triggerIds[0]!, triggerIds }
    let ticket: Ticket = { id, title: outcome.title, decisionId, mandate, channels: [], assignments: [], inputs: [], undelivered: [],
      createdAt: at, updatedAt: at, origin }
    for (const triggerId of triggerIds) {
      const channel = this.repo.triggers.get(triggerId)?.channel
      if (channel && !ticket.channels.some(item => sameChannel(item, channel))) ticket.channels.push(channel)
    }
    ticket = this.options.prepareTicket?.(ticket, outcome) ?? ticket
    // L1 结果卡：新单首次启动就带上同域 ready 单的只读结论。卡片记成一条 note，但刻意不放进 undelivered，
    // 因此不追加投递、不新建 assignment；它随首次 launch 的 assignment 文本一起发给 worker。
    const query = [ticket.title, mandate.scope, ...triggerIds.flatMap(triggerId => {
      const trigger = this.repo.triggers.get(triggerId)
      return trigger ? [trigger.text, trigger.url ?? ''] : []
    })].join('\n').slice(0, 4_000)
    const cards = matchResultCards(this.repo.tickets.list(), query)
    if (cards.length) {
      const at = this.now()
      const text = resultCardNote(cards)
      ticket.inputs.push({ id: key('input', id, 'result-cards', ...cards.map(card => card.ticketId)), kind: 'note', text, at })
      if (ticket.execution) {
        ticket.execution = { ...ticket.execution,
          assignment: ticket.execution.assignment ? `${ticket.execution.assignment}\n\n${text}` : text }
      }
    }
    // 批次 2：建单即做一次确定性自动组队。与 create 的其余写入同属 repo.atomic，
    // 组名、置信度与写域随工单一并落盘；没有命中时工单形状与引入自动组队前完全一致。
    this.autoCollab(ticket, at)
    const assignment = this.newAssignment(ticket)
    this.repo.tickets.save(ticket)
    for (const triggerId of triggerIds) for (const ref of this.repo.triggers.get(triggerId)?.threads ?? []) this.subscribe(id, ref)
    if (outcome.acknowledgement && primary) this.replies.acknowledgeAccepted(id, primary, outcome.acknowledgement)
    this.options.executor.start(this.require(id), assignment)
    this.emit('ticket.created', { ticketId: id, decisionId, strength: mandate.strength })
  }
  /**
   * Subscribes an open ticket to `thread` and records it in `ticket.follows` (`own` when opened by the ticket).
   * @throws UserError when the ticket is unknown or has ended.
   */
  bind(ticketId: string, thread: ThreadRef, own: boolean): Ticket {
    if (!liveTicket(this.require(ticketId))) throw new UserError('ticketEnded')
    this.subscribe(ticketId, thread)
    const ticket = this.require(ticketId)
    const followed = threadKey(thread)
    const follow = ticket.follows?.find(item => item.thread === followed)
    // Re-binding a thread reopens it if previously closed; `own` remains true once set.
    if (follow) { follow.own ||= own; delete follow.closed } else ticket.follows = [...ticket.follows ?? [], { thread: followed, own }]
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    return ticket
  }
  /**
   * 给一张 open 工单加组或改组，全量写入组内角色与依赖：未给的 role 与 dependsOn 会被清除。
   * 一组最多四张工单；依赖只能指向同组的其他 open 工单，不能自依赖或成环。组关系只是路由与看板事实，不改授权、不建批次。
   * @throws UserError 工单未知或已结束、组名或角色不合法、组已满、依赖越界或成环。
   */
  collab(ticketId: string, change: CollaborationInput): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const group = change.group.trim()
    if (!group || group.length > 64 || /[\s/]/.test(group)) throw new UserError('collabGroupInvalid')
    const role = change.role?.trim() || undefined
    if (role && (role.length > 40 || /[\r\n]/.test(role))) throw new UserError('collabRoleInvalid')
    const dependsOn = [...new Set(change.dependsOn ?? [])]
    if (dependsOn.length > GROUP_LIMIT - 1) throw new UserError('collabDependency')
    const members = this.repo.tickets.list().filter(item => item.collab?.group === group && item.id !== ticketId)
    if (members.length >= GROUP_LIMIT) throw new UserError('collabGroupFull')
    const dependencies = dependsOn.filter(id => id !== ticketId && this.repo.tickets.get(id)?.collab?.group === group
      && liveTicket(this.repo.tickets.get(id)!))
    if (dependencies.length !== dependsOn.length) throw new UserError('collabDependency')
    // 本次写入只改本工单的出边，任何新环都必须经过本工单：从每个依赖出发能回到本工单即成环。
    const edges = new Map<string, readonly string[]>(members.map(item => [item.id, item.collab?.dependsOn ?? []]))
    edges.set(ticketId, dependencies)
    const seen = new Set<string>()
    const stack = [...dependencies]
    while (stack.length) {
      const id = stack.pop()!
      if (id === ticketId) throw new UserError('collabCycle')
      if (seen.has(id)) continue
      seen.add(id)
      stack.push(...edges.get(id) ?? [])
    }
    ticket.collab = { group, ...(role ? { role } : {}), ...(dependencies.length ? { dependsOn: dependencies } : {}) }
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    return this.require(ticketId)
  }
  /**
   * 建单时的自动组队：取最近活动的 open 工单，用 `collab-auto` 的确定性规则决定加入已有自动组
   * 或与一张相关工单新建组。只改 `collab` 与首次 assignment 文本，不新增 note、不唤醒任何工单；
   * 人工组（没有 `auto` 标记）不参与自动合并。由 `create` 在同一个事务里调用。
   */
  private autoCollab(ticket: Ticket, at: string): void {
    if (this.options.collabAuto === false || ticket.collab) return
    const view = collabView(ticket, this.ticketThreads(ticket))
    const candidates: AutoCandidate[] = this.repo.tickets.open()
      .filter(candidate => candidate.id !== ticket.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20)
      .flatMap(candidate => {
        const candidateView = collabView(candidate, this.ticketThreads(candidate))
        const group = this.candidateGroup(candidate, candidateView)
        return [{ view: candidateView, ...(group ? { group } : {}) }]
      })
    const plan = planAutoGroup(view, candidates, at)
    if (!plan) return
    ticket.collab = { group: plan.group, auto: true, confidence: plan.confidence, signals: plan.signals,
      writeScopes: view.writeScopes, expiresAt: plan.expiresAt, ...(plan.dependsOn.length ? { dependsOn: plan.dependsOn } : {}) }
    // 首次 assignment 就告诉 worker 读组看板；不额外投递 note、不额外唤醒。
    if (ticket.execution) {
      const line = `Collaboration group: ${plan.group}. Read group/${plan.group} first; group notes are terminal results only.`
      ticket.execution = { ...ticket.execution,
        assignment: ticket.execution.assignment ? `${ticket.execution.assignment}\n\n${line}` : line }
    }
    // 新建组时把组名、置信度与 TTL 写回另一张成员单。
    if (!plan.created) return
    for (const id of plan.members) {
      if (id === ticket.id) continue
      const member = this.repo.tickets.get(id)
      if (!member) continue
      member.collab = { group: plan.group, auto: true, confidence: plan.confidence, signals: plan.signals,
        writeScopes: collabView(member, this.ticketThreads(member)).writeScopes, expiresAt: plan.expiresAt }
      this.repo.tickets.save(member)
    }
  }
  /** 一张工单的 Thread key，取自它的 origin triggers 与它跟随的 Thread。 */
  private ticketThreads(ticket: Ticket): string[] {
    return [...new Set(ticket.origin.triggerIds.flatMap(id => this.repo.triggers.get(id)?.threads ?? []).map(threadKey)
      .concat((ticket.follows ?? []).map(follow => follow.thread)))]
  }
  /**
   * 候选工单所在的自动组视图；人工组或混合组返回 undefined，自动组队就不会把新单塞进人工组。
   */
  private candidateGroup(ticket: Ticket, view: ReturnType<typeof collabView>): CandidateGroup | undefined {
    const name = ticket.collab?.group
    if (!name) return undefined
    const members = this.repo.tickets.list().filter(item => item.collab?.group === name)
    // 人工组或人工/自动混合组：返回 auto=false，自动聚类会直接跳过，绝不改写人工组。
    if (!ticket.collab?.auto || members.some(item => !item.collab?.auto)) return { id: name, auto: false, members: [] }
    const expiresAt = members.flatMap(item => item.collab?.expiresAt ? [item.collab.expiresAt] : []).sort()[0]
    return { id: name, auto: true, ...(expiresAt ? { expiresAt } : {}),
      members: members.map(item => item.id === ticket.id ? view : collabView(item, this.ticketThreads(item))) }
  }
  /**
   * 解散一张工单所在的协作组（人工工具的覆盖手段）：清掉所有成员的 `collab`，因此不再广播终态。
   * @returns 被移出组的工单 id；没有组时为空。
   */
  dissolveCollab(ticketId: string): string[] {
    const name = this.repo.tickets.get(ticketId)?.collab?.group
    if (!name) return []
    const members = this.repo.tickets.list().filter(item => item.collab?.group === name)
    for (const member of members) { delete member.collab; this.repo.tickets.save(member) }
    return members.map(member => member.id)
  }
  /**
   * 时钟触发的自动组回收：全部成员结束、成员少于两张、2 h TTL 到期、成员报告与组无关，
   * 或 30 min 内没有任何组内 note 被投递（近似“无交叉读取”）时解散。返回解散的组数。
   */
  dissolveDueCollab(): number {
    const groups = new Map<string, Ticket[]>()
    for (const ticket of this.repo.tickets.list()) {
      const name = ticket.collab?.group
      if (name) groups.set(name, [...groups.get(name) ?? [], ticket])
    }
    let dissolved = 0
    for (const [, members] of groups) {
      // 只要有一张成员是人工加入的，整个组按人工组处理，不自动解散。
      if (members.some(member => !member.collab?.auto)) continue
      if (!this.collabDissolvable(members)) continue
      for (const member of members) { delete member.collab; this.repo.tickets.save(member) }
      dissolved++
    }
    return dissolved
  }
  /** 一个自动组是否已满足解散条件；规则见 `dissolveDueCollab`。 */
  private collabDissolvable(members: readonly Ticket[]): boolean {
    if (members.length < 2) return true
    if (members.every(member => !liveTicket(member))) return true
    const expiry = members.flatMap(member => member.collab?.expiresAt ? [Date.parse(member.collab.expiresAt)] : [])
      .filter(Number.isFinite).sort((a, b) => a - b)[0]
    if (expiry !== undefined && expiry <= Date.parse(this.now())) return true
    if (members.some(member => {
      const report = latestReport(member)
      return report?.state === 'dropped' && UNRELATED.test(report.summary)
    })) return true
    return this.noCrossRead(members)
  }
  /**
   * 30 min 内没有交叉读取。note 没有 readAt，这里用两个确定性近似：
   * 组内 note 仍在本单 `undelivered` 里就是没投递；投递过则取该单最新 assignment 的 `deliveredAt`。
   */
  private noCrossRead(members: readonly Ticket[]): boolean {
    const live = members.filter(liveTicket)
    if (!live.length) return true
    const now = Date.parse(this.now())
    const notes = live.flatMap(member => member.inputs.flatMap(input => input.kind === 'note' && input.from && input.from !== member.id
      ? [{ member, input }] : []))
    let last = Number.NaN
    if (!notes.length) {
      const expiry = members.flatMap(member => member.collab?.expiresAt ? [Date.parse(member.collab.expiresAt)] : [])
        .filter(Number.isFinite).sort((a, b) => a - b)[0]
      last = expiry === undefined ? Number.NaN : expiry - AUTO_GROUP_TTL_MS
    } else {
      const delivered = notes.filter(({ member, input }) => !member.undelivered.includes(input.id))
      last = delivered.length
        ? Math.max(...delivered.flatMap(({ member }) => {
          const at = Date.parse(latestAssignment(member)?.deliveredAt ?? '')
          return Number.isFinite(at) ? [at] : []
        }))
        : Math.max(...notes.map(({ input }) => Date.parse(input.at)).filter(Number.isFinite))
    }
    return Number.isFinite(last) && now - last >= ACTIVITY_MS
  }
  /**
   * Record that a Thread open tickets follow closed, and end each one done with its Threads (see `followsDone`), unless its
   * work has not finished (see `unfinished`); such work ends the ticket once it reports ready.
   */
  threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void {
    const closed = threadKey(thread)
    for (const ticket of this.repo.tickets.open()) {
      const follow = ticket.follows?.find(item => item.thread === closed && !item.closed)
      if (!follow) continue
      follow.closed = { at, outcome }
      this.repo.tickets.save(ticket)
      const done = this.followsDone(ticket)
      if (!done || this.unfinished(ticket, at)) continue
      // Work resumed after the close and finished ends now.
      const resumed = Date.parse(latestAssignment(ticket)?.createdAt ?? '') > Date.parse(at)
      this.end(ticket.id, 'executor', done.outcome, resumed ? this.now() : done.at)
    }
  }
  /**
   * How a ticket that follows Threads is done with them: once no Thread it opened (`own`) is still open, or, when it opened none,
   * once every one it follows closed. It ends as the latest close among those Threads did; undefined while it is not done.
   */
  followsDone(ticket: Ticket): Follow['closed'] {
    const follows = ticket.follows ?? []
    const own = follows.filter(item => item.own)
    const counted = own.length ? own : follows
    if (!counted.length || counted.some(item => !item.closed)) return undefined
    return counted.map(item => item.closed!).sort((a, b) => a.at.localeCompare(b.at)).at(-1)
  }
  /**
   * The Trigger to attach to a ticket, once the ticket may take it.
   * @throws UserError when the trigger or ticket is unknown, a ticket's worker still decides the trigger, a person stopped the ticket, or an ended ticket's Mandate no longer revalidates.
   */
  attachable(ticketId: string, triggerId: string): Trigger {
    const trigger = this.repo.triggers.get(triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // A follow-up that reached a ticket goes elsewhere only once the workers that decide it hand it back.
    this.leftToWorkers(trigger)
    const current = this.require(ticketId)
    if (current.ended?.by === 'human') throw new UserError('ticketStopped')
    if (!liveTicket(current) && !this.policy().revalidate(current.mandate)) throw new UserError('mandateRevoked')
    return trigger
  }
  /**
   * Subscribe a ticket to an attached Trigger's Threads and add the Trigger as an Input, with its note. The ticket's worker
   * then decides it, as it decides a message that reached the ticket on its own Thread; a worker that does not hold the
   * message as its ticket's takes it as a new Input, which wakes an ended ticket as any attached message does.
   */
  attach(ticketId: string, trigger: Trigger, note?: string): void {
    for (const ref of trigger.threads) this.subscribe(ticketId, ref)
    // A person's sending it to Eval, which routed it here, is over, and so is the ticket's reading it for context only.
    const current: TriggerDisposition = this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at: this.now() }
    const { context, requeued, ...disposition } = current
    const followed = context?.filter(id => id !== ticketId)
    this.repo.triggers.saveDisposition(trigger.id, { ...disposition, fanout: [...new Set([...disposition.fanout, ticketId])],
      ...followed?.length ? { context: followed } : {} })
    const ticket = this.require(ticketId)
    const id = key('input', ticketId, 'trigger', trigger.id)
    const existing = ticket.inputs.find(input => input.id === id)
    const at = this.now()
    const input = (inputId: string): TicketInput => ({ id: inputId, kind: 'trigger', triggerId: trigger.id, at, ...(note ? { note } : {}),
      ...trigger.human ? { human: true } : {} })
    if (existing?.kind !== 'trigger') this.addInput(ticket, input(id))
    else if (note && ticket.undelivered.includes(id)) { existing.note = note; ticket.updatedAt = at; this.repo.tickets.save(ticket) }
    // A person sent it to Eval, or the ticket let it go before its worker took it up, read it for context only, or ended after
    // its worker had it, so the worker gets it again.
    else if (requeued || !current.fanout.includes(ticketId) || context?.includes(ticketId) || !liveTicket(ticket)) {
      this.addInput(ticket, input(key('input', ticketId, 'trigger', trigger.id, 'attached', at)))
    }
    // The worker has the message already, so the note comes with it again.
    else if (note) this.addInput(ticket, input(key('input', ticketId, 'trigger', trigger.id, 'note', note)))
  }
  /**
   * Ask a running worker whose latest report is `waiting` for a status report; leaves any other ticket alone.
   * @returns whether the status request input was queued.
   * @throws UserError when the ticket is unknown.
   */
  requestStatus(ticketId: string): boolean {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket) || runningAssignment(ticket)?.report?.state !== 'waiting') return false
    this.addInput(ticket, { id: `status:${ticketId}:${ticket.updatedAt}`, kind: 'text', text: STATUS_REQUEST, at: this.now() })
    return true
  }
  /**
   * Stops a ticket on behalf of a human, ending any active assignments.
   * @throws UserError when the ticket is unknown.
   */
  stop(ticketId: string, reason?: string): Ticket {
    this.end(ticketId, 'human', 'stopped', this.now(), reason)
    return this.require(ticketId)
  }
  /**
   * Ends the stalled assignment of a retryable open ticket (`failed`, `blocked`, or failed input delivery) and starts a new one.
   * @throws UserError when the ticket is unknown or not retryable.
   */
  retry(ticketId: string): Ticket {
    const ticket = this.require(ticketId)
    const latest = latestAssignment(ticket)
    if (!canRetry(ticket) || !latest) throw new UserError('notRetryable')
    this.endAssignment(ticket, latest, 'retried')
    this.requeueUntaken(ticket, latest)
    const assignment = this.newAssignment(ticket)
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    this.options.executor.stop(ticket, latest, 'retried')
    this.options.executor.start(ticket, assignment)
    return ticket
  }
  /**
   * Drops a ticket's Subscription to a Thread its worker found unrelated, and hands back, with `reason`, the person's messages there that the ticket decides.
   * @throws UserError when the ticket is unknown, or `thread` is an origin thread, a bound `follows` thread, or not subscribed.
   */
  markUnrelated(ticketId: string, thread: string, reason: string): void {
    const ticket = this.require(ticketId)
    if (this.source(ticket)?.threads.some(ref => threadKey(ref) === thread)) throw new UserError('sourceThread')
    if (ticket.follows?.some(item => item.thread === thread)) throw new UserError('followedThread')
    if (!this.repo.threads.get(thread)?.subscriptions.includes(ticketId)) throw new UserError('notFollowing')
    this.dropSubscriptions(thread, 'executor', ticketId, reason)
    // Its worker found the Thread is not its ticket's: it hands back, with its reason, the person's messages there it decides.
    for (const trigger of this.triggersOf(ticket)) {
      if (trigger.threads.some(ref => threadKey(ref) === thread) && this.owners(trigger).includes(ticketId)) this.handBack(ticketId, trigger, reason)
    }
  }
  /**
   * Tell each open ticket a Policy change bears on how it does, oldest first, so their deliveries queue in the order they
   * were accepted; the others are left alone.
   */
  policyChanged(from: string, to: string, effects: ReadonlyMap<string, PolicyEffect>): void {
    const at = this.now()
    // Iterate tickets oldest first so deliveries queue in acceptance order.
    for (const ticket of this.repo.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const effect = effects.get(ticket.id)
      // Include `at` in the input key so repeated transitions between the same policy versions still record a new input.
      if (effect) this.addInput(ticket, { id: key('input', ticket.id, 'policy', from, to, at), kind: 'policy-changed', from, to, at, effect })
    }
  }
  /**
   * 清理指向已不存在工单的悬空订阅，以及它们残留的 context 标记；返回清掉的订阅数。
   * 已结束但记录仍在的工单保留订阅：同 Thread 上的人类追问仍可唤醒它（见 `wake`），
   * 系统/机器人消息由 `Intake.receive` 跳过，不产生无效 fanout。
   */
  cleanSubscriptions(threadKeys?: readonly string[]): number {
    let removed = 0
    const threads = threadKeys?.length ? threadKeys.flatMap(key => this.repo.threads.get(key) ?? []) : this.repo.threads.list()
    for (const thread of threads) {
      const kept = thread.subscriptions.filter(id => this.repo.tickets.get(id))
      const context = thread.context?.filter(id => kept.includes(id))
      const changed = kept.length !== thread.subscriptions.length || (context?.length ?? 0) !== (thread.context?.length ?? 0)
      if (!changed) continue
      removed += thread.subscriptions.length - kept.length
      thread.subscriptions = kept
      if (context) thread.context = context
      this.repo.threads.save(thread)
    }
    return removed
  }
  /**
   * Drop a Thread's Subscriptions, every ticket's or only `ticketId`'s, and say so; false when none dropped. A ticket that
   * followed the Thread follows it no more, so its close no longer ends the ticket. Each ticket keeps deciding the messages
   * it received from the Thread.
   */
  dropSubscriptions(thread: string, by: 'person' | 'executor', ticketId?: string, reason?: string): boolean {
    const current = this.repo.threads.get(thread)
    const tickets = current?.subscriptions.filter(id => ticketId === undefined || id === ticketId) ?? []
    if (!current || !tickets.length) return false
    current.subscriptions = current.subscriptions.filter(id => !tickets.includes(id))
    this.repo.threads.save(current)
    for (const id of tickets) {
      const ticket = this.repo.tickets.get(id)
      if (!ticket?.follows?.some(item => item.thread === thread)) continue
      const { follows: before, ...rest } = ticket
      const follows = before.filter(item => item.thread !== thread)
      this.repo.tickets.save(follows.length ? { ...rest, follows } : rest)
    }
    for (const id of tickets) this.emit('thread.unsubscribed', { threadKey: current.key, ticketId: id, by, ...(reason ? { reason } : {}) })
    return true
  }
  /**
   * Add an Input once (idempotently) and ask the Executor to deliver it, or to launch again a pending Assignment whose launch
   * failed once no person is waited for: a Policy change alone does not launch it again.
   */
  addInput(ticket: Ticket, input: TicketInput): void {
    if (ticket.inputs.some(existing => existing.id === input.id)) return
    ticket.inputs.push(input); ticket.updatedAt = this.now()
    // Hold back automated inputs while the worker is waiting on a person.
    const held = liveTicket(ticket) && automatic(input) && waitsForPerson(ticket)
    if (!held) ticket.undelivered.push(input.id)
    this.repo.tickets.save(ticket)
    if (!liveTicket(ticket) || held) return
    const running = runningAssignment(ticket), latest = latestAssignment(ticket)
    if (running) this.options.executor.deliver(ticket, running)
    else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.options.executor.start(ticket, latest)
  }
  /**
   * Resume an ended ticket under its unchanged Mandate when a person's message on one of its Threads waits for it: no Eval
   * and no Decision, since nothing new is authorized. One whose Mandate the current Policy no longer holds stays ended and
   * takes nothing (see `refuse`). While processing is paused the message waits, and the first pass after the pause resumes
   * the ticket under the Policy then. Reads the ticket afresh, so it is idempotent and leaves an already-resumed ticket alone.
   */
  wake(ticketId: string): void {
    const ticket = this.repo.tickets.get(ticketId)
    if (!ticket || liveTicket(ticket) || ticket.ended?.by === 'human' || !ticket.undelivered.length) return
    const policy = this.policy()
    if (policy.paused) return
    if (!policy.revalidate(ticket.mandate)) { this.refuse(ticket); return }
    // Only a human's message resumes an ended ticket; bot/CI triggers wait alongside inputs from before the ticket ended.
    const first = ticket.undelivered.map(id => ticket.inputs.find(input => input.id === id)).find(input => input?.kind === 'trigger' && input.human)
    if (first?.kind !== 'trigger') return
    const at = this.now()
    delete ticket.ended; ticket.updatedAt = at
    const assignment = this.newAssignment(ticket)
    // Prepend the resumed marker so it is delivered ahead of the waiting messages.
    const resumed: TicketInput = { id: key('input', ticket.id, 'resumed', first.triggerId), kind: 'resumed', triggerId: first.triggerId, at }
    ticket.inputs.push(resumed); ticket.undelivered.unshift(resumed.id)
    this.repo.tickets.save(ticket)
    this.options.executor.start(ticket, assignment)
    this.emit('ticket.resumed', { ticketId, triggerId: first.triggerId })
  }
  /** The Triggers of a ticket's trigger Inputs, or of those of them whose Input ids are `ids`. */
  private triggersOf(ticket: Ticket, ids?: readonly string[]): Trigger[] {
    return ticket.inputs.flatMap(input => input.kind === 'trigger' && (!ids || ids.includes(input.id))
      ? this.repo.triggers.get(input.triggerId) ?? [] : [])
  }
  /**
   * Whether a ticket's worker took a person's message up, by acknowledging or answering it. A message acknowledged before
   * acknowledgements were recorded on it has only the acknowledgement's message in the outbox.
   */
  private takenUp(ticket: Ticket, trigger: Trigger): boolean {
    const acked = this.repo.triggers.disposition(trigger.id)?.acked
    return acked ? acked.includes(ticket.id) : this.options.outbox.status(key('ack', trigger.id)) !== undefined
  }
  /** The person's messages among a ticket's Inputs `ids` that it decides and its worker did not take up. */
  private untaken(ticket: Ticket, ids: readonly string[]): Trigger[] {
    return this.triggersOf(ticket, ids).filter(trigger => this.owners(trigger).includes(ticket.id) && !this.takenUp(ticket, trigger))
  }
  /**
   * A ticket that ended, or cannot resume, lets go of the messages its worker never received, `waiting`, and of the person's
   * messages it decided but may not have taken up, `left`: it no longer counts as having reached them, and each of `left`
   * that no other ticket decides goes to Eval, as a person's message that reached no ticket does, unless a ticket took it
   * up, a Decision settled it, or it is the message a stop ended this ticket on.
   */
  private letGo(ticketId: string, waiting: readonly Trigger[], left: readonly Trigger[]): void {
    for (const trigger of [...waiting, ...left]) {
      const disposition = this.repo.triggers.disposition(trigger.id)
      if (disposition?.fanout.includes(ticketId)) {
        this.repo.triggers.saveDisposition(trigger.id, { ...disposition, fanout: disposition.fanout.filter(id => id !== ticketId) })
      }
    }
    for (const trigger of left) {
      const disposition = this.repo.triggers.disposition(trigger.id)
      const decision = disposition?.decisionId ? this.repo.decisions.get(disposition.decisionId) : undefined
      // The main Session that stopped this ticket on the message decides the rest of it itself, unless a ticket handed it back.
      const stopped = decision?.kind === 'stop' && decision.ticketId === ticketId && !disposition?.handbacks?.length
      const decided = !!decision && (settled(decision) || stopped)
      if (!this.owners(trigger).length && !disposition?.acked?.length && !decided) this.queueForEval(trigger)
    }
  }
  /** An ended ticket that cannot resume takes none of the messages that waited for it (see `letGo`). */
  private refuse(ticket: Ticket): void {
    const waiting = this.triggersOf(ticket, ticket.undelivered), left = this.untaken(ticket, ticket.undelivered)
    ticket.undelivered = []
    this.repo.tickets.save(ticket)
    this.letGo(ticket.id, waiting, left)
  }
  /** Replace a ticket's running Assignment with a new one that receives `note` first, and queue it for launch. */
  restart(ticket: Ticket, running: Assignment, reason: string, note: string): void {
    this.endAssignment(ticket, running, reason)
    this.requeueUntaken(ticket, running)
    const assignment = this.newAssignment(ticket)
    const at = this.now()
    const input: TicketInput = { id: key('input', ticket.id, 'restart', assignment.id), kind: 'text', text: note, at }
    ticket.inputs.push(input); ticket.undelivered.push(input.id); ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    this.options.executor.start(ticket, assignment)
  }
  /**
   * Put back, ahead of what waits, the Trigger Inputs delivered to `replaced` that no step of its worker took: a cancel may
   * have dropped them, or a step that claimed them was cut off, and the new Assignment's launch takes a copy still waiting
   * in the Session out, so its delivery is the only one. An earlier end let go of what earlier Assignments left.
   */
  private requeueUntaken(ticket: Ticket, replaced: Assignment): void {
    const untaken = ticket.inputs.filter(input => input.kind === 'trigger' && input.readAt === null && input.deliveredTo === replaced.id
      && !ticket.undelivered.includes(input.id))
    ticket.undelivered.unshift(...untaken.map(input => input.id))
  }
  /**
   * End a ticket with its outcome. `at` records when the ending fact happened, such as a PR merge, and `reason` says
   * why in words, by default the outcome. The ticket lets go (see `letGo`) of the messages its worker never received, and of
   * the person's messages it decides that its worker did not read before its latest report or turn end, the report that
   * ends the ticket included (see `readBefore`), and neither acknowledged, answered nor handed back: one may have come while
   * the worker wrote the report that ends the ticket, or after its turn ended, and either way it can no longer hand it back.
   */
  end(ticketId: string, by: TicketEndBy, outcome: TicketOutcome, at = this.now(), reason?: string): void {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) return
    const stopping = ticket.assignments.filter(assignment => assignment.state !== 'ended')
    const why = reason && reason !== outcome ? { reason } : {}
    const until = readUntil(ticket)
    const waiting = this.triggersOf(ticket, ticket.undelivered)
    const left = this.untaken(ticket, ticket.inputs.flatMap(input => input.kind === 'trigger'
      && (!readBefore(input, until) || ticket.undelivered.includes(input.id)) ? [input.id] : []))
    // An end dated earlier, such as a PR's merge, does not move the ticket's last change back.
    ticket.ended = { at, by, outcome, ...why }; ticket.undelivered = []; ticket.updatedAt = this.now()
    delete ticket.attention; delete ticket.delivery
    // The Assignments the end stops end with it; the ticket's end says why.
    for (const assignment of stopping) { assignment.state = 'ended'; assignment.endedAt = at }
    this.repo.tickets.save(ticket)
    // 订阅不随 ended 删除：已结束单的订阅是同 thread 人类追问历史的索引（候选卡、related_tickets 都读它）；
    // Intake 对机器人/CI 消息跳过已结束单，只让人类消息按 `wake` 语义唤醒它。
    this.letGo(ticketId, waiting, left)
    this.emit('ticket.ended', { ticketId, by, outcome, ...why })
    for (const assignment of stopping) this.options.executor.stop(ticket, assignment, reason ?? outcome)
  }
  /**
   * Whether a ticket's work has not finished at a close at `at`: its worker took up a person's message the ticket decides and
   * has not reported other than progress, or ended a turn, since its Session took that message into a step, or work resumed
   * after the close, whose Assignment started after it, has no ready report or Input arrived after that report; a Policy
   * change asks for no work.
   */
  private unfinished(ticket: Ticket, at: string): boolean {
    const until = readUntil(ticket, false)
    const taken = this.triggersOf(ticket, ticket.inputs.flatMap(input => input.kind === 'trigger' && !readBefore(input, until) ? [input.id] : []))
      .some(trigger => this.owners(trigger).includes(ticket.id) && this.takenUp(ticket, trigger))
    const latest = latestAssignment(ticket)
    if (taken || !(Date.parse(latest?.createdAt ?? '') > Date.parse(at))) return taken
    const report = latest?.report
    const later = ticket.inputs.some(input => input.kind !== 'policy-changed' && Date.parse(input.at) > Date.parse(report?.at ?? ''))
    return report?.state !== 'ready' || ticket.undelivered.length > 0 || later
  }
  /** Add a pending Assignment; a failed delivery to the one before it no longer concerns the ticket. */
  private newAssignment(ticket: Ticket): Assignment {
    const assignment: Assignment = { id: key('assignment', ticket.id, String(ticket.assignments.length)), state: 'pending', createdAt: this.now() }
    ticket.assignments.push(assignment)
    delete ticket.delivery
    return assignment
  }
  private endAssignment(ticket: Ticket, assignment: Assignment, reason: string): void {
    assignment.state = 'ended'; assignment.endedAt = this.now(); assignment.endedReason = reason
    this.emit('assignment.ended', { ticketId: ticket.id, assignmentId: assignment.id, reason })
  }
  /**
   * Give an open ticket's Executor a fact as a note Input, such as what another ticket found; it grants nothing (see `TicketInput`).
   * @throws UserError when the ticket is unknown or has ended.
   */
  note(ticketId: string, text: string): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const at = this.now()
    this.addInput(ticket, { id: key('input', ticketId, 'note', at, text), kind: 'note', text, at })
    return this.require(ticketId)
  }
  /**
   * 把一张工单的终态报告（ready/blocked/failed）广播给同组其他工单：每条 note 记录来源工单和结果指针，
   * 按 assignmentId+state 幂等。progress/waiting/dropped 不广播——dropped 表示没有可复用结果，广播它只会制造空转噪声。
   * 活着的工单照常收到并投递；已结束的工单只落输入，addInput 不会唤醒它。
   */
  shareReport(ticketId: string, assignmentId: string, state: ReportState): void {
    if (!SHARED_REPORTS.has(state)) return
    const source = this.repo.tickets.get(ticketId)
    const group = source?.collab?.group
    if (!source || !group) return
    const at = this.now()
    for (const member of this.repo.tickets.list()) {
      if (member.id === ticketId || member.collab?.group !== group) continue
      const text = `Group ${group}: ticket ${ticketId} reported ${state}. Result: ticket/${ticketId}/result.`
      this.addInput(member, { id: key('input', member.id, 'collab', ticketId, assignmentId, state), kind: 'note', text, at, from: ticketId })
    }
  }
  /**
   * Subscribe an open ticket to a Thread its Executor found related, for context: see `Thread.context`.
   * @returns false when the ticket follows the Thread already.
   * @throws UserError when the ticket is unknown or has ended.
   */
  followForContext(ticketId: string, ref: ThreadRef): boolean {
    if (!liveTicket(this.require(ticketId))) throw new UserError('ticketEnded')
    if (this.thread(ref).subscriptions.includes(ticketId)) return false
    this.subscribe(ticketId, ref)
    const thread = this.thread(ref)
    thread.context = [...thread.context ?? [], ticketId]
    this.repo.threads.save(thread)
    return true
  }
  /** Subscribe a ticket to a Thread; later Triggers on it reach the ticket as Inputs, as the ticket's own once it was for context. */
  private subscribe(ticketId: string, ref: ThreadRef): void {
    const thread = this.thread(ref)
    if (!thread.subscriptions.includes(ticketId)) { thread.subscriptions.push(ticketId); this.emit('thread.subscribed', { threadKey: thread.key, ticketId }) }
    if (thread.context?.includes(ticketId)) thread.context = thread.context.filter(id => id !== ticketId)
    this.repo.threads.save(thread)
  }
}
