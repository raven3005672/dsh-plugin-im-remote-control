/**
 * Local contracts for the Host half.
 *
 * These describe only what this plugin touches. They are deliberately local
 * rather than imported from `@deepseek-ai/dsh-*`: the plugin runs against a
 * packaged application whose published type packages version independently, and
 * a narrow hand-written interface fails at compile time when a field we rely on
 * changes shape, which is the signal we want.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** One text part of a prompt. */
export interface PromptTextPart {
  readonly type: 'text'
  readonly text: string
}

/** Prompt admission request accepted by the Session controller. */
export interface SessionPromptRequest {
  readonly requestId: string
  readonly sessionId: string
  readonly mode: 'queue' | 'steer'
  readonly content: readonly PromptTextPart[]
  readonly clientTimeZone?: string
}

/** One message part of an assembled assistant message. */
interface MessagePart {
  readonly type: string
  readonly text?: string
}

/** The session fields this plugin reads from `session/event`. */
export interface SessionLike {
  readonly id: string
}

/** Event fields this plugin reads; the union is merged by the application. */
export interface SessionEventLike {
  readonly type: string
  readonly data?: {
    readonly source?: { readonly rpcId?: string }
    readonly message?: { readonly content?: readonly MessagePart[] }
    /** Present on `turn/end`; the closed vocabulary the harness documents. */
    readonly reason?: { readonly kind?: string }
  }
}

/** Closed decision vocabulary returned to the approval service. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** The approval request fields this plugin reads from `approval/request`. */
export interface ApprovalRequestEvent {
  /** Agent that needs the decision; its session is what ties the ask to a chat. */
  readonly agent: { readonly session: { readonly id: string } }
  /** Tool whose operation requires a decision. */
  readonly toolName: string
  /** Exact tool call being decided, when the asker had one. */
  readonly callId?: string
  /** Asker's explanation of why it is asking. */
  readonly reason?: string
  /** Localized presentation of the reason, when the asker supplied one. */
  readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
  /** Aborting the ask withdraws it; the request then settles `cancelled`. */
  readonly signal?: AbortSignal
}

/** One selectable answer offered for a question. */
export interface AskUserQuestionOption {
  /** User-facing label; also what an answer carries back. */
  readonly label: string
  /** Optional supporting line rendered under the question. */
  readonly description?: string
}

/**
 * Presentation intent the asker attached to a question. Only plan review is
 * defined today: the labeled option approves the plan, every other declines it.
 */
export interface AskUserQuestionIntent {
  readonly kind: 'plan-review'
  /** Option label that approves the plan. */
  readonly approve: string
  /** Tool call whose arguments carry the plan, when the asker named one. */
  readonly callId?: string
}

/** One question the agent asks the human. */
export interface AskUserQuestionItem {
  /** Stable id echoed in the answer. */
  readonly id: string
  /** The question itself. */
  readonly question: string
  /** Optional supporting detail kept out of option labels. */
  readonly detail?: string
  /** Optional short heading. */
  readonly header?: string
  /** Choices the chat can render as buttons. */
  readonly options?: readonly AskUserQuestionOption[]
  /** Whether more than one label may be selected. */
  readonly multiSelect?: boolean
  /** Optional presentation intent; absent asks for the generic option list. */
  readonly intent?: AskUserQuestionIntent
}

/** Answer to one question, keyed by its id. */
export interface AskUserQuestionAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** The human's answer batch, in question order. */
export interface AskUserQuestionAnswer {
  readonly answers: readonly AskUserQuestionAnswerItem[]
}

/** The question request fields this plugin reads from `user-questions/request`. */
export interface UserQuestionRequestEvent {
  /** Questions to display. */
  readonly questions: readonly AskUserQuestionItem[]
  /** Agent whose tool call is waiting; its session ties the ask to a chat. */
  readonly agent?: { readonly session: { readonly id: string } }
  /** Aborting the request withdraws it. */
  readonly signal?: AbortSignal
  /** Timed-ask bookkeeping; a foreground wait is bounded by the tool row. */
  readonly wait?: { readonly callId: string; readonly timed?: boolean }
}

/** Registration options accepted by the dispatch context. */
export interface ListenerOptions {
  /** Run this listener before those registered earlier for the same event. */
  readonly prepend?: boolean
}

/** Exact HTTP route accepted by the Host WebServer. */
export interface WebServerRoute {
  readonly kind: 'exact'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** Host services this plugin injects. */
export interface HostContext {
  readonly sessionController: {
    prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<unknown>
  }
  readonly webServer: {
    register(route: WebServerRoute): () => void
  }
  effect(callback: () => (() => void) | void, label?: string): void
  on(event: 'session/event', listener: (session: SessionLike, event: SessionEventLike) => void): () => void
  on(
    event: 'approval/request',
    listener: (request: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>,
    options?: ListenerOptions,
  ): () => void
  on(
    event: 'user-questions/request',
    listener: (request: UserQuestionRequestEvent, next: () => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer>,
    options?: ListenerOptions,
  ): () => void
}

/** Plugin config row as delivered by the Loader (volatile fields are reactive). */
export type RawConfig = Record<string, unknown>
