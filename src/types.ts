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
}

/** Plugin config row as delivered by the Loader (volatile fields are reactive). */
export type RawConfig = Record<string, unknown>
