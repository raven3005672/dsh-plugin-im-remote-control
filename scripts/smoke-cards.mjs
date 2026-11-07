// Keyless card smoke: the card payloads and the question bookkeeping are what
// the Feishu callback trusts, so this asserts the button values, the card
// states, and the question aggregation/race/timeout without Feishu or a mount.
import assert from 'node:assert/strict'

const { QuestionRegistry, parseAnswerCommand } = await import('../lib/questions.js')
const {
  approvalCard, approvalResolvedCard, questionCard, questionClosedCard, parseCardAction,
} = await import('../lib/cards.js')

const never = () => new Promise(() => {})
const question = (id, overrides = {}) => ({ id, question: `问题 ${id}`, ...overrides })

/** A registry wired to recording sinks. */
function harness({ timeoutMs = 60_000 } = {}) {
  const notices = []
  const updated = []
  const resolved = []
  const registry = new QuestionRegistry({
    timeoutMs,
    notify: (notice) => notices.push(notice),
    updated: (notice, messageId) => updated.push({ id: notice.id, messageId }),
    resolved: (notice, resolution, messageId) => resolved.push({ id: notice.id, resolution, messageId }),
  })
  return { registry, notices, updated, resolved }
}

/** Button values in one card, flattened. */
function buttons(card) {
  const out = []
  for (const element of card.elements) {
    if (element.tag !== 'action') continue
    for (const action of element.actions) out.push(action.value)
  }
  return out
}

/** Concatenated text of one card. */
function text(card) {
  return JSON.stringify(card)
}

// --- /answer parsing ---------------------------------------------------------
assert.deepEqual(parseAnswerCommand('/answer ab12cd 用 TypeScript'), { id: 'ab12cd', text: '用 TypeScript' })
assert.deepEqual(parseAnswerCommand('  /ANSWER 0123ab  第一项,第二项  '), { id: '0123ab', text: '第一项,第二项' })
assert.equal(parseAnswerCommand('/answer ab12cd'), undefined)
assert.equal(parseAnswerCommand('/answer zz11 x'), undefined)
assert.equal(parseAnswerCommand('/approve ab12cd'), undefined)

// --- approval cards ----------------------------------------------------------
{
  const notice = { id: 'ab12cd', chatId: 'chat-1', name: '股票分析', toolName: 'bash', detail: '要执行 rm -rf build' }
  const card = approvalCard(notice, 120)
  assert.equal(card.header.template, 'orange')
  assert.deepEqual(buttons(card), [
    { k: 'approval', id: 'ab12cd', v: 'allow' },
    { k: 'approval', id: 'ab12cd', v: 'deny' },
  ])
  assert.match(text(card), /\/approve ab12cd/u)

  assert.equal(approvalResolvedCard(notice, 'allowed-once').header.template, 'green')
  assert.equal(approvalResolvedCard(notice, 'rejected').header.template, 'red')
  assert.equal(approvalResolvedCard(notice, 'timeout').header.template, 'grey')
  assert.equal(approvalResolvedCard(notice, 'cancelled').header.template, 'grey')
  assert.equal(buttons(approvalResolvedCard(notice, 'allowed-once')).length, 0, 'resolved cards carry no actions')
}

// --- question cards ----------------------------------------------------------
{
  const questions = [
    question('q1', { header: '方案', options: [{ label: 'A' }, { label: 'B' }] }),
    question('q2', { multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] }),
    question('q3'),
  ]
  const answers = new Map()
  const pending = questionCard({ id: 'cd34ef', questions, answers, timeoutSec: 300 })
  assert.equal(pending.header.template, 'orange')
  assert.deepEqual(buttons(pending), [
    { k: 'question', id: 'cd34ef', q: 'q1', v: 'A' },
    { k: 'question', id: 'cd34ef', q: 'q1', v: 'B' },
  ])
  assert.match(text(pending), /\/answer cd34ef/u, 'the text fallback is always named')

  answers.set('q1', { id: 'q1', selected: ['B'] })
  const progress = questionCard({ id: 'cd34ef', questions, answers, timeoutSec: 300 })
  assert.match(text(progress), /✅ 已回答：B/u, 'answered questions show their answer')
  assert.equal(buttons(progress).length, 0, 'answered, multi-select and free-text questions carry no buttons')

  const mixedPending = questionCard({
    id: 'cd34ef',
    questions: [question('q1', { options: [{ label: 'A' }, { label: 'B' }] }), question('q2', { options: [{ label: 'C' }, { label: 'D' }] })],
    answers: new Map([['q1', { id: 'q1', selected: ['B'] }]]),
    timeoutSec: 300,
  })
  assert.equal(buttons(mixedPending).length, 2, 'the unanswered single-select question keeps its buttons')
  assert.deepEqual(buttons(mixedPending)[0], { k: 'question', id: 'cd34ef', q: 'q2', v: 'C' })

  const done = questionClosedCard({ id: 'cd34ef', questions, answers, timeoutSec: 300 }, 'answered')
  assert.equal(done.header.template, 'green')
  assert.match(text(done), /→ B/u)
  assert.equal(questionClosedCard({ id: 'cd34ef', questions, answers, timeoutSec: 300 }, 'timeout').header.template, 'grey')
}

// --- action values -----------------------------------------------------------
assert.deepEqual(parseCardAction({ k: 'approval', id: 'ab12cd', v: 'allow' }), { kind: 'approval', id: 'ab12cd', value: 'allow' })
assert.deepEqual(parseCardAction({ k: 'question', id: 'cd34ef', q: 'q1', v: 'A' }), { kind: 'question', id: 'cd34ef', value: 'A', questionId: 'q1' })
assert.equal(parseCardAction({ k: 'approval', id: 'not-hex' }), undefined)
assert.equal(parseCardAction({ k: 'other', id: 'ab12cd' }), undefined)
assert.equal(parseCardAction('approval'), undefined)

// --- a complete card answer settles the request ------------------------------
{
  const { registry, notices, resolved } = harness()
  const controller = new AbortController()
  const request = { questions: [question('q1', { options: [{ label: 'A' }, { label: 'B' }] })], signal: controller.signal }
  const pending = registry.forward('chat-1', '本会话', request, never)
  assert.equal(notices.length, 1, 'the card is published before the local answerer runs')
  assert.equal(notices[0].chatId, 'chat-1')
  assert.equal(notices[0].timeoutSec, 60)
  assert.notEqual(request.signal, controller.signal, 'the asker lifetime is replaced so the card can retract it')

  assert.deepEqual(registry.answerCard(notices[0].id, 'chat-1', 'q1', 'B'), { status: 'settled', id: notices[0].id })
  assert.deepEqual(await pending, { answers: [{ id: 'q1', selected: ['B'] }] })
  assert.equal(registry.size, 0)
  assert.equal(request.signal.aborted, true, 'settling the card retracts the desktop prompt')
  assert.deepEqual(resolved.at(-1), { id: notices[0].id, resolution: 'answered', messageId: undefined })
}

// --- an incomplete answer reports progress and keeps the card open -----------
{
  const { registry, notices, updated } = harness()
  const pending = registry.forward('chat-1', '本会话', {
    questions: [question('q1', { options: [{ label: 'A' }, { label: 'B' }] }), question('q2', { options: [{ label: 'C' }] })],
  }, never)
  assert.deepEqual(registry.answerCard(notices[0].id, 'chat-1', 'q1', 'A'), { status: 'partial', id: notices[0].id, remaining: 1 })
  assert.equal(registry.size, 1)
  assert.equal(updated.length, 1)
  assert.deepEqual(registry.answerCard(notices[0].id, 'chat-1', 'q2', 'C'), { status: 'settled', id: notices[0].id })
  assert.deepEqual(await pending, { answers: [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['C'] }] })
}

// --- foreign and unknown ids never settle ------------------------------------
{
  const { registry, notices } = harness()
  const pending = registry.forward('chat-1', '本会话', { questions: [question('q1', { options: [{ label: 'A' }] })] }, never)
  assert.equal(registry.answerCard(notices[0].id, 'chat-2', 'q1', 'A').status, 'foreign')
  assert.equal(registry.answerCard('ffffff', 'chat-1', 'q1', 'A').status, 'unknown')
  assert.equal(registry.size, 1, 'a foreign chat does not consume the request')
  assert.equal(registry.answerCard(notices[0].id, 'chat-1', 'q1', 'not-an-option').status, 'unsupported')
  registry.answerCard(notices[0].id, 'chat-1', 'q1', 'A')
  await pending
}

// --- multi-select and free text go through /answer ---------------------------
{
  const { registry, notices } = harness()
  const pending = registry.forward('chat-1', '本会话', {
    questions: [question('q1', { multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }] })],
  }, never)
  assert.equal(registry.answerCard(notices[0].id, 'chat-1', 'q1', 'X').status, 'unsupported')
  assert.deepEqual(registry.answerText(notices[0].id, 'chat-1', 'X, Z'), { status: 'settled', id: notices[0].id })
  assert.deepEqual(await pending, { answers: [{ id: 'q1', selected: ['X', 'Z'] }] })

  const free = harness()
  const freePending = free.registry.forward('chat-1', '本会话', { questions: [question('q1')] }, never)
  free.registry.answerText(free.notices[0].id, 'chat-1', '用 pnpm')
  assert.deepEqual(await freePending, { answers: [{ id: 'q1', selected: [], custom: '用 pnpm' }] })

  const mixed = harness()
  const mixedPending = mixed.registry.forward('chat-1', '本会话', {
    questions: [question('q1', { options: [{ label: 'A' }, { label: 'B' }] })],
  }, never)
  mixed.registry.answerText(mixed.notices[0].id, 'chat-1', 'B')
  assert.deepEqual(await mixedPending, { answers: [{ id: 'q1', selected: ['B'] }] }, 'an exact label is a selection, not custom text')
}

// --- timeout, abort and dispose withdraw the card ----------------------------
{
  const { registry, notices, resolved } = harness({ timeoutMs: 20 })
  registry.forward('chat-1', '本会话', { questions: [question('q1')] }, never)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(registry.size, 0, 'an unanswered request is withdrawn at the deadline')
  assert.equal(resolved.at(-1).resolution, 'timeout')
  assert.equal(registry.answerCard(notices[0].id, 'chat-1', 'q1', 'A').status, 'unknown')

  const aborted = harness()
  const controller = new AbortController()
  aborted.registry.forward('chat-1', '本会话', { questions: [question('q1')], signal: controller.signal }, never)
  controller.abort()
  assert.equal(aborted.registry.size, 0)
  assert.equal(aborted.resolved.at(-1).resolution, 'cancelled')

  const disposed = harness()
  disposed.registry.forward('chat-1', '本会话', { questions: [question('q1')] }, never)
  disposed.registry.dispose()
  assert.equal(disposed.registry.size, 0)
  assert.equal(disposed.resolved.at(-1).resolution, 'cancelled')
}

// --- the local answerer can win the race -------------------------------------
{
  const { registry, resolved } = harness()
  const local = { answers: [{ id: 'q1', selected: ['A'] }] }
  const pending = registry.forward('chat-1', '本会话', { questions: [question('q1')] }, async () => local)
  assert.deepEqual(await pending, local)
  assert.equal(registry.size, 0, 'a local answer withdraws the card')
  assert.equal(resolved.at(-1).resolution, 'elsewhere')
}

console.log('smoke-cards ok')
