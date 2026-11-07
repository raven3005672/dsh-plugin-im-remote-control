/**
 * Feishu interactive-card payloads for approvals and questions.
 *
 * Cards are plain JSON in Feishu's card 1.0 schema: a header, markdown blocks,
 * action rows of buttons, and a note. Buttons carry the small `{ k, id, v }`
 * value this plugin's callback parses; nothing else about the card is trusted.
 *
 * This module is pure so the shapes can be asserted without Feishu.
 *
 * @module dsh-plugin-im-remote-control/cards
 */
import type { ApprovalNotice } from './approval.ts'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from './types.ts'

/** How an approval ended, as the card presents it. */
export type ApprovalResolution = 'allowed-once' | 'rejected' | 'timeout' | 'cancelled'

/** What one question card shows: the pending request and answers so far. */
export interface QuestionCardView {
  /** Short id the note names for the text fallback. */
  readonly id: string
  /** Questions in ask order. */
  readonly questions: readonly AskUserQuestionItem[]
  /** Answers already supplied, keyed by question id. */
  readonly answers: ReadonlyMap<string, AskUserQuestionAnswerItem>
  /** Seconds the card stays actionable. */
  readonly timeoutSec: number
}

/** One parsed button value. */
export interface CardActionRef {
  /** Which registry owns the click. */
  readonly kind: 'approval' | 'question'
  /** Short id of the pending approval or question request. */
  readonly id: string
  /** Approval: `allow` or `deny`. Question: the selected option label. */
  readonly value?: string
  /** Question id the clicked option belongs to. */
  readonly questionId?: string
}

/** Cards are untyped JSON on the wire; a local alias keeps signatures honest. */
export type FeishuCard = Record<string, unknown>

const MAX_DETAIL = 900

function clip(text: string, limit = MAX_DETAIL): string {
  const value = text.trim()
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

function plain(content: string): Record<string, unknown> {
  return { tag: 'plain_text', content }
}

function markdown(content: string): Record<string, unknown> {
  return { tag: 'div', text: { tag: 'lark_md', content } }
}

function note(content: string): Record<string, unknown> {
  return { tag: 'note', elements: [plain(content)] }
}

function button(label: string, type: 'primary' | 'danger' | 'default', value: Record<string, unknown>): Record<string, unknown> {
  return { tag: 'button', text: plain(label), type, value }
}

function card(title: string, template: string, elements: Record<string, unknown>[]): FeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: { title: plain(title), template },
    elements,
  }
}

/** The approval ask: what the tool wants, why, and the two decisions. */
export function approvalCard(notice: ApprovalNotice, timeoutSec: number): FeishuCard {
  const lines = [
    `**会话**：${notice.name}`,
    `**工具**：${notice.toolName}`,
    ...(notice.detail !== undefined ? [clip(notice.detail)] : notice.reason === undefined ? [] : [`**原因**：${clip(notice.reason)}`]),
  ]
  return card(`需要审批 · ${notice.toolName}`, 'orange', [
    markdown(lines.join('\n')),
    {
      tag: 'action',
      actions: [
        button('批准一次', 'primary', { k: 'approval', id: notice.id, v: 'allow' }),
        button('拒绝', 'danger', { k: 'approval', id: notice.id, v: 'deny' }),
      ],
    },
    note(`审批 ${notice.id} · ${String(timeoutSec)} 秒内有效 · 也可回复 /approve ${notice.id}`),
  ])
}

/** The settled approval: buttons removed, outcome stated. */
export function approvalResolvedCard(notice: ApprovalNotice, resolution: ApprovalResolution): FeishuCard {
  const [title, template, result] = resolution === 'allowed-once'
    ? ['✅ 已批准', 'green', '已批准（来自飞书）']
    : resolution === 'rejected'
      ? ['❌ 已拒绝', 'red', '已拒绝（来自飞书）']
      : resolution === 'timeout'
        ? ['⌛ 已超时', 'grey', '超时未处理，已自动拒绝']
        : ['已取消', 'grey', '请求已取消']
  return card(title, template, [
    markdown([`**会话**：${notice.name}`, `**工具**：${notice.toolName}`, `**结果**：${result}`].join('\n')),
    note(`审批 ${notice.id}`),
  ])
}

/** Option labels of an answered question, for the resolved card. */
function answerText(answer: AskUserQuestionAnswerItem | undefined): string {
  if (answer === undefined) return '未回答'
  if (answer.custom !== undefined && answer.custom !== '') return answer.custom
  return answer.selected.length === 0 ? '未回答' : answer.selected.join('、')
}

function questionBlock(question: AskUserQuestionItem, index: number, answered: AskUserQuestionAnswerItem | undefined, view: QuestionCardView): Record<string, unknown>[] {
  const head = question.header === undefined || question.header === ''
    ? `**${String(index + 1)}. ${question.question}**`
    : `**${question.header}**\n**${String(index + 1)}. ${question.question}**`
  const lines = [head]
  if (question.detail !== undefined && question.detail !== '') lines.push(clip(question.detail))
  if (answered !== undefined) {
    lines.push(`✅ 已回答：${answerText(answered)}`)
    return [markdown(lines.join('\n'))]
  }
  const options = question.options ?? []
  if (options.length === 0) {
    lines.push(`请回复 /answer ${view.id} <文本>`)
    return [markdown(lines.join('\n'))]
  }
  if (question.multiSelect === true) {
    lines.push(`选项：${options.map((option) => option.label).join(' / ')}`)
    lines.push(`可多选，回复 /answer ${view.id} 选项1,选项2`)
    return [markdown(lines.join('\n'))]
  }
  return [
    markdown(lines.join('\n')),
    {
      tag: 'action',
      actions: options.map((option, optionIndex) => button(
        option.label,
        optionIndex === 0 ? 'primary' : 'default',
        { k: 'question', id: view.id, q: question.id, v: option.label },
      )),
    },
  ]
}

/** The pending question card: one block and one button row per unanswered question. */
export function questionCard(view: QuestionCardView): FeishuCard {
  const elements: Record<string, unknown>[] = []
  view.questions.forEach((question, index) => {
    elements.push(...questionBlock(question, index, view.answers.get(question.id), view))
  })
  const plan = view.questions.some((question) => question.intent?.kind === 'plan-review')
  elements.push(note(`请求 ${view.id} · ${String(view.timeoutSec)} 秒内有效 · 自定义回答：/answer ${view.id} <文本>`))
  return card(plan ? '计划待确认' : '需要你回答', 'orange', elements)
}

/** The settled question card: every question with its final answer. */
export function questionResolvedCard(view: QuestionCardView): FeishuCard {
  const elements = view.questions.map((question) => markdown(
    `**${question.question}**\n→ ${answerText(view.answers.get(question.id))}`,
  ))
  return card('✅ 已回答', 'green', [...elements, note(`请求 ${view.id}`)])
}

/** How a question request closed, as its card presents it. */
export type QuestionClose = 'answered' | 'elsewhere' | 'timeout' | 'cancelled'

/** The closed question card: answered, or withdrawn for another reason. */
export function questionClosedCard(view: QuestionCardView, close: QuestionClose): FeishuCard {
  if (close === 'answered') return questionResolvedCard(view)
  const [title, template, line] = close === 'timeout'
    ? ['⌛ 已超时', 'grey', '超时未回答，问题已撤回。']
    : close === 'elsewhere'
      ? ['已在其他界面处理', 'grey', '这个问题已在桌面或其他界面回答。']
      : ['已取消', 'grey', '问题已取消。']
  return card(title, template, [markdown(line), note(`请求 ${view.id}`)])
}

/** Parse a button value; anything this plugin did not write is ignored. */
export function parseCardAction(value: unknown): CardActionRef | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const kind = raw.k === 'approval' || raw.k === 'question' ? raw.k : undefined
  const id = typeof raw.id === 'string' && /^[0-9a-f]{4,12}$/.test(raw.id) ? raw.id : undefined
  if (kind === undefined || id === undefined) return undefined
  return {
    kind,
    id,
    ...(typeof raw.v === 'string' ? { value: raw.v } : {}),
    ...(typeof raw.q === 'string' && raw.q !== '' ? { questionId: raw.q } : {}),
  }
}
