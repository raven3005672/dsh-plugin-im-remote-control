/**
 * Remote approval bookkeeping: one pending decision per ask, keyed by a short
 * id the chat can type.
 *
 * The registry owns only timing and settlement. Publishing the notice and
 * reporting an expiry are injected, which keeps the whole state machine
 * runnable without Feishu or a mounted plugin.
 *
 * @module dsh-plugin-im-remote-control/approval
 */
import { randomBytes } from 'node:crypto'
import type { ApprovalOutcome, ApprovalRequestEvent } from './types.ts'
import type { ApprovalResolution } from './cards.ts'

/** `/approve <id>` or `/deny <id>`; ids are short lowercase hex. */
const COMMAND = /^\/(approve|deny)\s+([0-9a-f]{4,12})$/u

/** One approval decision read from a chat message. */
export interface ApprovalCommand {
  /** `approve` grants the one-shot permission, `deny` rejects it. */
  readonly verb: 'approve' | 'deny'
  /** Short id of the pending approval being answered. */
  readonly id: string
}

/**
 * Read an approval decision command from a chat message.
 * @param text - raw message text.
 * @returns the verb and approval id, or undefined when the message is not a command.
 */
export function parseApprovalCommand(text: string): ApprovalCommand | undefined {
  const match = COMMAND.exec(text.trim().toLowerCase())
  if (match === null) return undefined
  const [, verb, id] = match
  if (verb === undefined || id === undefined) return undefined
  return { verb: verb === 'approve' ? 'approve' : 'deny', id }
}

/** One ask as it appears to the chat that must decide it. */
export interface ApprovalNotice {
  /** Short id the reply must name. */
  readonly id: string
  /** Chat that owns the turn that asked. */
  readonly chatId: string
  /** Session label shown to the reader. */
  readonly name: string
  /** Tool whose operation needs the decision. */
  readonly toolName: string
  /** Asker's own explanation of why it is asking, when it supplied one. */
  readonly reason?: string
  /** Localized presentation of that explanation, preferred over `reason`. */
  readonly detail?: string
}

/** Result of applying one chat reply to the pending set. */
export type ApprovalAnswer =
  | { readonly status: 'settled'; readonly id: string; readonly toolName: string; readonly outcome: 'allowed-once' | 'rejected' }
  | { readonly status: 'unknown' }
  | { readonly status: 'foreign'; readonly toolName: string }

/** Side effects the registry does not own. */
export interface ApprovalRegistryOptions {
  /** Post one fresh ask to its chat. */
  notify(notice: ApprovalNotice): void
  /** Rewrite the ask's card once it is decided, expired or withdrawn. */
  resolved?(notice: ApprovalNotice, messageId: string | undefined, resolution: ApprovalResolution): void
  /** Report an ask that timed out with no decision. */
  expire(notice: ApprovalNotice): void
  /** Milliseconds a chat may take before its silence is treated as a rejection. */
  timeoutMs: number
}

/** One ask waiting for a chat decision. */
interface Pending {
  readonly notice: ApprovalNotice
  readonly chatId: string
  readonly toolName: string
  /** Card message this ask was published as, when it was published as a card. */
  messageId?: string
  readonly resolve: (outcome: ApprovalOutcome) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly detach: () => void
}

/** Pending decisions a chat can still answer. */
export class ApprovalRegistry {
  private readonly pendings = new Map<string, Pending>()

  /**
   * @param options - notice sink, expiry sink, and the answer deadline.
   */
  constructor(private readonly options: ApprovalRegistryOptions) {}

  /** Number of asks still waiting for a decision. */
  get size(): number {
    return this.pendings.size
  }

  /**
   * Register one ask and race the chat against the rest of the answerer chain.
   *
   * The ask is published before `next()` runs, so the chat can answer even when
   * a later answerer never settles. Whichever path decides first settles the
   * ask; the loser is discarded.
   * @param chatId - chat that owns the turn that asked.
   * @param name - session label shown to the reader.
   * @param request - the pending approval.
   * @param next - remaining answerers.
   * @returns the first decision made by either path.
   */
  forward(
    chatId: string,
    name: string,
    request: ApprovalRequestEvent,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const detail = request.displayReason?.zh ?? request.displayReason?.en
    const notice: ApprovalNotice = {
      id: this.freshId(),
      chatId,
      name,
      toolName: request.toolName,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      ...(detail === undefined ? {} : { detail }),
    }
    const lifetime = this.ownLifetime(request)
    const remote = this.register(notice, lifetime.signal)
    // `unavailable` and a throwing answerer mean "the rest of the chain produced
    // no decision", not "the decision is deny"; racing them as a result would
    // retract the chat prompt before anyone could answer it. This promise never
    // settles and is owned by this ask, so it is collected with the ask.
    const noDecision = new Promise<ApprovalOutcome>(() => {})
    let local: Promise<ApprovalOutcome>
    try {
      local = next()
    } catch {
      // A throwing answerer is contained by the approval service as
      // `unavailable`; treat it as silence so the chat can still decide.
      local = noDecision
    }
    return Promise.race([remote, local.then(
      (outcome) => (outcome === 'unavailable' ? noDecision : outcome),
      () => noDecision,
    )]).finally(() => {
      this.cancel(notice.id)
      // The ask is decided: retract whatever prompt a later answerer posted.
      lifetime.abort()
    })
  }

  /**
   * Apply one `/approve` or `/deny` reply.
   * @param chatId - chat the reply came from.
   * @param command - parsed verb and approval id.
   * @returns what the reply did, so the caller can phrase its acknowledgement.
   */
  answer(chatId: string, command: ApprovalCommand): ApprovalAnswer {
    return this.decide(chatId, command.id, command.verb === 'approve' ? 'allowed-once' : 'rejected')
  }

  /**
   * Apply one card click.
   * @param id - short approval id carried by the button.
   * @param chatId - chat the card was posted in.
   * @param allow - true for the approve button, false for deny.
   * @returns what the click did, so the callback can phrase its toast.
   */
  resolveCard(id: string, chatId: string, allow: boolean): ApprovalAnswer {
    return this.decide(chatId, id, allow ? 'allowed-once' : 'rejected')
  }

  /**
   * Remember the card message an ask was published as.
   * @param id - short approval id.
   * @param messageId - Feishu message id of the card.
   */
  attachCard(id: string, messageId: string): void {
    const entry = this.pendings.get(id)
    if (entry !== undefined) entry.messageId = messageId
  }

  /**
   * The ask as published, for a caller that must re-render its card.
   * @param id - short approval id.
   */
  noticeOf(id: string): ApprovalNotice | undefined {
    return this.pendings.get(id)?.notice
  }

  /** Withdraw every pending ask; used when the plugin unmounts. */
  dispose(): void {
    for (const id of [...this.pendings.keys()]) this.settle(id, 'cancelled')
  }

  /**
   * Take over the ask's cancellation lifetime.
   *
   * Answerers later in the chain (the desktop bridge) tie the prompt they post
   * — and that prompt's dismissal — to `request.signal`, and the waterfall
   * offers no other way to retract a prompt another answerer already showed. A
   * chat decision therefore retracts the desktop prompt by aborting this
   * lifetime, which the chain ends up observing instead of the asker's.
   * @param request - the pending approval, borrowed from the asker.
   * @returns the controller whose signal replaces the asker's.
   */
  private ownLifetime(request: ApprovalRequestEvent): AbortController {
    const controller = new AbortController()
    const source = request.signal
    if (source !== undefined) {
      const mirror = (): void => { controller.abort(source.reason) }
      if (source.aborted) mirror()
      else source.addEventListener('abort', mirror, { once: true })
    }
    try {
      Object.defineProperty(request, 'signal', {
        value: controller.signal,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    } catch {
      // A frozen request keeps the asker's signal: the chat can still answer,
      // but only a local decision dismisses the desktop prompt.
    }
    return controller
  }

  /**
   * Start the deadline and abort listener for one ask, then publish it.
   * @param notice - the ask as the chat sees it.
   * @param signal - cancellation lifetime of the pending request.
   * @returns the decision the chat eventually supplies.
   */
  private register(notice: ApprovalNotice, signal: AbortSignal | undefined): Promise<ApprovalOutcome> {
    let resolve!: (outcome: ApprovalOutcome) => void
    const remote = new Promise<ApprovalOutcome>((settle) => { resolve = settle })
    const onAbort = (): void => { this.settle(notice.id, 'cancelled') }
    if (signal !== undefined && !signal.aborted) signal.addEventListener('abort', onAbort, { once: true })
    const detach = (): void => { signal?.removeEventListener('abort', onAbort) }
    const timer = setTimeout(() => {
      if (this.settle(notice.id, 'rejected', true)) this.options.expire(notice)
    }, this.options.timeoutMs)
    this.pendings.set(notice.id, { notice, chatId: notice.chatId, toolName: notice.toolName, resolve, timer, detach })
    if (signal?.aborted === true) {
      // The request was withdrawn before the chat could see it: no notice.
      this.settle(notice.id, 'cancelled')
    } else {
      this.options.notify(notice)
    }
    return remote
  }

  /**
   * Settle one entry, releasing its timer and abort listener.
   * @param id - short approval id.
   * @param outcome - decision handed back to the approval service.
   * @param timedOut - whether the deadline, rather than a person, rejected it.
   * @returns whether an entry carried that id.
   */
  private settle(id: string, outcome: ApprovalOutcome, timedOut = false): boolean {
    const entry = this.pendings.get(id)
    if (entry === undefined) return false
    this.cancel(id)
    entry.resolve(outcome)
    const resolution: ApprovalResolution = timedOut
      ? 'timeout'
      : outcome === 'allowed-once' || outcome === 'rejected' ? outcome : 'cancelled'
    this.options.resolved?.(entry.notice, entry.messageId, resolution)
    return true
  }

  /**
   * Apply one decision after checking the ask belongs to the chat.
   * @param chatId - chat the decision came from.
   * @param id - short approval id.
   * @param outcome - the decision.
   * @returns what the decision did.
   */
  private decide(chatId: string, id: string, outcome: 'allowed-once' | 'rejected'): ApprovalAnswer {
    const entry = this.pendings.get(id)
    if (entry === undefined) return { status: 'unknown' }
    if (entry.chatId !== chatId) return { status: 'foreign', toolName: entry.toolName }
    this.settle(id, outcome)
    return { status: 'settled', id, toolName: entry.toolName, outcome }
  }

  /**
   * Drop one entry without settling it.
   * @param id - short approval id.
   */
  private cancel(id: string): void {
    const entry = this.pendings.get(id)
    if (entry === undefined) return
    this.pendings.delete(id)
    clearTimeout(entry.timer)
    entry.detach()
  }

  /**
   * Generate a short id no pending ask uses.
   * @returns a lowercase hex id the chat can type.
   */
  private freshId(): string {
    let id = randomBytes(3).toString('hex')
    while (this.pendings.has(id)) id = randomBytes(3).toString('hex')
    return id
  }
}
