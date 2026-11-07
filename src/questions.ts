/**
 * Remote question answering: one pending `user-questions/request` per ask,
 * answerable from a chat card or a `/answer` reply.
 *
 * The registry owns only timing, aggregation and settlement. Publishing the
 * card and patching it afterwards are injected, which keeps the state machine
 * runnable without Feishu.
 *
 * @module dsh-plugin-im-remote-control/questions
 */
import { randomBytes } from 'node:crypto'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  UserQuestionRequestEvent,
} from './types.ts'

/** `/answer <id> <text>`; ids are the same short lowercase hex as approvals. */
const COMMAND = /^\/answer\s+([0-9a-f]{4,12})\s+([\s\S]+)$/iu

/** One text answer read from a chat message. */
export interface QuestionCommand {
  /** Short id of the pending question request. */
  readonly id: string
  /** Raw answer text. */
  readonly text: string
}

/**
 * Read a `/answer` command from a chat message.
 * @param text - raw message text.
 * @returns the request id and answer text, or undefined when it is not a command.
 */
export function parseAnswerCommand(text: string): QuestionCommand | undefined {
  const match = COMMAND.exec(text.trim())
  if (match === null) return undefined
  const [, id, answer] = match
  if (id === undefined || answer === undefined) return undefined
  const trimmed = answer.trim()
  return trimmed === '' ? undefined : { id, text: trimmed }
}

/** One answer batch request as the chat sees it. */
export interface QuestionNotice {
  /** Short id the text fallback names. */
  readonly id: string
  /** Chat that owns the turn that asked. */
  readonly chatId: string
  /** Session label shown to the reader. */
  readonly name: string
  /** Questions in ask order. */
  readonly questions: readonly AskUserQuestionItem[]
  /** Answers supplied so far, keyed by question id. */
  readonly answers: ReadonlyMap<string, AskUserQuestionAnswerItem>
  /** Seconds the card stays actionable. */
  readonly timeoutSec: number
}

/** How a question request stopped waiting. */
export type QuestionResolution = 'answered' | 'elsewhere' | 'timeout' | 'cancelled'

/** Result of applying one answer to the pending set. */
export type QuestionAnswerResult =
  | { readonly status: 'settled'; readonly id: string }
  | { readonly status: 'partial'; readonly id: string; readonly remaining: number }
  | { readonly status: 'unknown' }
  | { readonly status: 'foreign' }
  | { readonly status: 'unsupported'; readonly reason: string }

/** Side effects the registry does not own. */
export interface QuestionRegistryOptions {
  /** Post one fresh question card to its chat. */
  notify(notice: QuestionNotice): void
  /** Rewrite the card after a partial answer (progress). */
  updated?(notice: QuestionNotice, messageId?: string): void
  /** Rewrite the card once the request stops waiting. */
  resolved?(notice: QuestionNotice, resolution: QuestionResolution, messageId?: string): void
  /** Milliseconds a card stays actionable before it is withdrawn. */
  timeoutMs: number
}

/** One request waiting for an answer. */
interface Pending {
  readonly notice: QuestionNotice
  readonly answers: Map<string, AskUserQuestionAnswerItem>
  /** Card message this request was published as, when it was published as one. */
  messageId?: string
  readonly resolve: (answer: AskUserQuestionAnswer) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly detach: () => void
}

/** Pending question requests the chat can still answer. */
export class QuestionRegistry {
  private readonly pendings = new Map<string, Pending>()

  /**
   * @param options - card sinks, the progress sink, and the answer deadline.
   */
  constructor(private readonly options: QuestionRegistryOptions) {}

  /** Number of requests still waiting for an answer. */
  get size(): number {
    return this.pendings.size
  }

  /**
   * Publish one question card and race the chat against the rest of the chain.
   *
   * The card is published before `next()` runs, so the chat can answer even
   * when no other answerer exists. Whichever path answers first wins; a card
   * that nobody clicks is withdrawn at the deadline, leaving the other
   * answerers to handle the request as if this plugin were not mounted.
   * @param chatId - chat that owns the turn that asked.
   * @param name - session label shown on the card.
   * @param request - the pending question batch.
   * @param next - remaining answerers.
   * @returns the first answer produced by either path.
   */
  forward(
    chatId: string,
    name: string,
    request: UserQuestionRequestEvent,
    next: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    const lifetime = this.ownLifetime(request)
    const id = this.freshId()
    const answers = new Map<string, AskUserQuestionAnswerItem>()
    const notice: QuestionNotice = {
      id,
      chatId,
      name,
      questions: request.questions,
      answers,
      timeoutSec: Math.round(this.options.timeoutMs / 1_000),
    }
    const remote = new Promise<AskUserQuestionAnswer>((resolve) => {
      this.register(notice, answers, lifetime.signal, resolve)
    })
    const noDecision = new Promise<AskUserQuestionAnswer>(() => {})
    let local: Promise<AskUserQuestionAnswer>
    try {
      local = next()
    } catch {
      // A throwing answerer contributes nothing; the card can still answer.
      local = noDecision
    }
    return Promise.race([remote, local]).finally(() => {
      // The other surface answered first: withdraw the card and the prompt.
      this.finish(id, 'elsewhere')
      lifetime.abort()
    })
  }

  /**
   * Apply one card button: the selected option of one question.
   * @param id - short request id carried by the button.
   * @param chatId - chat the card was posted in.
   * @param questionId - question the button belongs to.
   * @param label - selected option label.
   * @returns what the click did, so the callback can phrase its toast.
   */
  answerCard(id: string, chatId: string, questionId: string, label: string): QuestionAnswerResult {
    const entry = this.lookup(id, chatId)
    if ('status' in entry) return entry
    const question = entry.notice.questions.find((item) => item.id === questionId)
    if (question === undefined) return { status: 'unknown' }
    if (question.multiSelect === true || (question.options ?? []).length === 0) {
      return { status: 'unsupported', reason: `这题请用 /answer ${id} <文本> 回答` }
    }
    if (!(question.options ?? []).some((option) => option.label === label)) {
      return { status: 'unsupported', reason: '选项已失效，请用 /answer 回答' }
    }
    entry.answers.set(questionId, { id: questionId, selected: [label] })
    return this.completeOrPartial(entry)
  }

  /**
   * Apply one `/answer` reply to the first unanswered question.
   * @param id - short request id.
   * @param chatId - chat the reply came from.
   * @param text - answer text; option labels are matched first, otherwise it is
   *   carried as the free-form answer.
   * @returns what the reply did.
   */
  answerText(id: string, chatId: string, text: string): QuestionAnswerResult {
    const entry = this.lookup(id, chatId)
    if ('status' in entry) return entry
    const question = entry.notice.questions.find((item) => !entry.answers.has(item.id))
    if (question === undefined) return this.completeOrPartial(entry)
    const options = question.options ?? []
    const parts = question.multiSelect === true
      ? text.split(/[,，、]/u).map((part) => part.trim()).filter((part) => part !== '')
      : [text.trim()]
    const selected = parts.filter((part) => options.some((option) => option.label === part))
    if (options.length > 0 && selected.length === parts.length && parts.length > 0) {
      entry.answers.set(question.id, { id: question.id, selected })
    } else {
      entry.answers.set(question.id, { id: question.id, selected: [], custom: text.trim() })
    }
    return this.completeOrPartial(entry)
  }

  /**
   * Remember the card message a request was published as.
   * @param id - short request id.
   * @param messageId - Feishu message id of the card.
   */
  attachCard(id: string, messageId: string): void {
    const entry = this.pendings.get(id)
    if (entry !== undefined) entry.messageId = messageId
  }

  /**
   * The request as published, for a caller that must re-render its card.
   * @param id - short request id.
   */
  noticeOf(id: string): (QuestionNotice & { messageId?: string }) | undefined {
    const entry = this.pendings.get(id)
    return entry === undefined ? undefined : { ...entry.notice, ...(entry.messageId === undefined ? {} : { messageId: entry.messageId }) }
  }

  /** Withdraw every pending request; used when the plugin unmounts. */
  dispose(): void {
    for (const id of [...this.pendings.keys()]) this.finish(id, 'cancelled')
  }

  /**
   * Start the deadline and abort listener for one request, then publish it.
   * @param notice - the request as the chat sees it.
   * @param answers - the mutable answer map shared with the notice.
   * @param signal - cancellation lifetime of the pending request.
   * @param resolve - settles the race when the batch is complete.
   */
  private register(
    notice: QuestionNotice,
    answers: Map<string, AskUserQuestionAnswerItem>,
    signal: AbortSignal | undefined,
    resolve: (answer: AskUserQuestionAnswer) => void,
  ): void {
    const onAbort = (): void => { this.finish(notice.id, 'cancelled') }
    if (signal !== undefined && !signal.aborted) signal.addEventListener('abort', onAbort, { once: true })
    const detach = (): void => { signal?.removeEventListener('abort', onAbort) }
    const timer = setTimeout(() => { this.finish(notice.id, 'timeout') }, this.options.timeoutMs)
    timer.unref?.()
    this.pendings.set(notice.id, { notice, answers, resolve, timer, detach })
    if (signal?.aborted === true) {
      this.finish(notice.id, 'cancelled')
      return
    }
    this.options.notify(notice)
  }

  /**
   * Resolve the request when every question has an answer, otherwise report
   * progress and patch the card.
   * @param entry - the waiting request.
   * @returns settled or partial.
   */
  private completeOrPartial(entry: Pending): QuestionAnswerResult {
    const missing = entry.notice.questions.filter((question) => !entry.answers.has(question.id))
    if (missing.length > 0) {
      this.options.updated?.(entry.notice, entry.messageId)
      return { status: 'partial', id: entry.notice.id, remaining: missing.length }
    }
    const batch: AskUserQuestionAnswer = {
      answers: entry.notice.questions.map((question) => entry.answers.get(question.id) as AskUserQuestionAnswerItem),
    }
    this.finish(entry.notice.id, 'answered', batch)
    return { status: 'settled', id: entry.notice.id }
  }

  /**
   * Remove one request and report how it ended.
   * @param id - short request id.
   * @param resolution - why it stopped waiting.
   * @param batch - the answer batch, when the chat answered.
   * @returns whether an entry carried that id.
   */
  private finish(id: string, resolution: QuestionResolution, batch?: AskUserQuestionAnswer): boolean {
    const entry = this.pendings.get(id)
    if (entry === undefined) return false
    this.pendings.delete(id)
    clearTimeout(entry.timer)
    entry.detach()
    if (batch !== undefined) entry.resolve(batch)
    this.options.resolved?.(entry.notice, resolution, entry.messageId)
    return true
  }

  /**
   * Find a waiting request, rejecting ids from a foreign chat.
   * @param id - short request id.
   * @param chatId - chat the answer came from.
   */
  private lookup(id: string, chatId: string): Pending | QuestionAnswerResult {
    const entry = this.pendings.get(id)
    if (entry === undefined) return { status: 'unknown' }
    if (entry.notice.chatId !== chatId) return { status: 'foreign' }
    return entry
  }

  /**
   * Take over the request's cancellation lifetime, as approvals do: a card
   * answer must retract the desktop prompt the chain would otherwise show.
   * @param request - the pending question batch, borrowed from the asker.
   * @returns the controller whose signal replaces the asker's.
   */
  private ownLifetime(request: UserQuestionRequestEvent): AbortController {
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
      // A frozen request keeps the asker's signal: the card can still answer,
      // but only a local answer dismisses the desktop prompt.
    }
    return controller
  }

  /**
   * Generate a short id no pending request uses.
   * @returns a lowercase hex id the chat can type.
   */
  private freshId(): string {
    let id = randomBytes(3).toString('hex')
    while (this.pendings.has(id)) id = randomBytes(3).toString('hex')
    return id
  }
}
