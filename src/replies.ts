/**
 * Quoted-reply routing: which session produced the message a chat reply quotes.
 *
 * A dispatched turn's result is posted to the chat with its label. When the
 * reader quotes that message and answers it, the answer belongs to the session
 * that asked — not to the controller, which never saw the question. This map
 * remembers the outbound message id for a bounded time so that reply can be
 * routed back.
 *
 * @module dsh-plugin-im-remote-control/replies
 */

/** Where one outbound message came from. */
export interface QuotedRoute {
  /** Session whose turn produced the message. */
  readonly sessionId: string
  /** Chat the message was posted to; a quote from another chat does not match. */
  readonly chatId: string
  /** Session label prepended to that turn's result, when it had one. */
  readonly label?: string
  /** When the message was posted, for expiry. */
  readonly at: number
}

/**
 * Bounded, expiring map of outbound message id → producing session.
 *
 * Entries are never consumed on read: the same result may be quoted more than
 * once. Expired entries and the oldest overflow entries are dropped lazily.
 */
export class QuotedRoutes {
  private readonly routes = new Map<string, QuotedRoute>()

  /**
   * @param ttlMs - how long a posted message stays routable.
   * @param limit - most entries kept; the oldest are dropped first.
   */
  constructor(private readonly ttlMs: number, private readonly limit: number) {}

  /** Number of live entries. */
  get size(): number {
    return this.routes.size
  }

  /**
   * Remember one outbound message.
   * @param messageId - Feishu message id returned by the send call.
   * @param route - the session and chat that produced it.
   * @param now - clock override for tests.
   */
  remember(messageId: string, route: Omit<QuotedRoute, 'at'>, now = Date.now()): void {
    this.prune(now)
    this.routes.set(messageId, { ...route, at: now })
    while (this.routes.size > this.limit) {
      const oldest = this.routes.keys().next()
      if (oldest.done === true) break
      this.routes.delete(oldest.value)
    }
  }

  /**
   * Look up the session a quoted message came from.
   * @param messageId - the quoted message id.
   * @param chatId - chat the quote arrived in.
   * @param now - clock override for tests.
   * @returns the route, when it is live and belongs to this chat.
   */
  take(messageId: string, chatId: string, now = Date.now()): QuotedRoute | undefined {
    this.prune(now)
    const route = this.routes.get(messageId)
    if (route === undefined || route.chatId !== chatId) return undefined
    return route
  }

  /**
   * Drop expired entries.
   * @param now - current time.
   */
  private prune(now: number): void {
    const cutoff = now - this.ttlMs
    for (const [id, route] of this.routes) {
      if (route.at < cutoff) this.routes.delete(id)
    }
  }
}

/** One turn's receipt-suppression inputs. */
export interface ReceiptInput {
  /** The turn was started by a dispatch (its result is the visible receipt). */
  readonly dispatched: boolean
  /** The turn came from a quoted reply, which is never a dispatch receipt. */
  readonly quoted: boolean
  /** The turn runs in the controller session that admitted the message. */
  readonly isController: boolean
  /** When this chat last dispatched, if it did. */
  readonly dispatchedAt: number | undefined
  /** Current time. */
  readonly now: number
  /** How long a dispatch suppresses the controller's echo. */
  readonly windowMs: number
}

/**
 * Whether a turn result is the controller's dispatch echo and must stay silent.
 *
 * Only the controller's immediate turn is a receipt. A dispatched executor's
 * result is the answer the chat asked for, and a quoted reply's result answers
 * the reader directly — swallowing either hides a turn they are waiting on.
 * @param input - turn, session and dispatch-window facts.
 * @returns true when the result should not be posted.
 */
export function suppressesReceipt(input: ReceiptInput): boolean {
  if (input.dispatched || input.quoted || !input.isController) return false
  if (input.dispatchedAt === undefined) return false
  return input.dispatchedAt > input.now - input.windowMs
}
