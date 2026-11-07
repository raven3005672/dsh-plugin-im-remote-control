// Keyless approval smoke: the pending-decision bookkeeping is timing- and
// lifecycle-sensitive — a stuck ask blocks a tool call and leaves a chat prompt
// nobody can answer — so this exercises the remote/local race, abort, timeout,
// command replies, and unmount cleanup without Feishu or a mounted plugin.
import assert from 'node:assert/strict'

const { ApprovalRegistry, parseApprovalCommand } = await import('../lib/approval.js')

const never = () => new Promise(() => {})
const request = (overrides = {}) => ({ agent: { session: { id: 'session-1' } }, toolName: 'bash', ...overrides })

/** A registry wired to recording sinks; `timeoutMs` defaults high enough to stay out of the way. */
function harness({ timeoutMs = 60_000 } = {}) {
  const notices = []
  const expired = []
  const resolved = []
  const registry = new ApprovalRegistry({
    timeoutMs,
    notify: (notice) => notices.push(notice),
    expire: (notice) => expired.push(notice),
    resolved: (notice, messageId, resolution) => resolved.push({ id: notice.id, messageId, resolution }),
  })
  return { registry, notices, expired, resolved }
}

// --- command parsing ---------------------------------------------------------
assert.deepEqual(parseApprovalCommand('/approve ab12cd'), { verb: 'approve', id: 'ab12cd' })
assert.deepEqual(parseApprovalCommand('  /DENY 0123ab  '), { verb: 'deny', id: '0123ab' })
assert.equal(parseApprovalCommand('/approve'), undefined)
assert.equal(parseApprovalCommand('/approve zz11'), undefined)
assert.equal(parseApprovalCommand('/deny 0123ab extra'), undefined)
assert.equal(parseApprovalCommand('/whoami'), undefined)
assert.equal(parseApprovalCommand('批准 ab12cd'), undefined)

// --- a chat decision settles an ask the desktop never answers ----------------
{
  const { registry, notices } = harness()
  const pending = registry.forward('chat-1', '股票分析', request({ reason: 'raw', displayReason: { en: 'English', zh: '中文' } }), never)
  assert.equal(notices.length, 1, 'ask published before the local answerer ran')
  const notice = notices[0]
  assert.match(notice.id, /^[0-9a-f]{6}$/u)
  assert.equal(notice.chatId, 'chat-1')
  assert.equal(notice.name, '股票分析')
  assert.equal(notice.toolName, 'bash')
  assert.equal(notice.detail, '中文', 'the localized detail is preferred for display')
  assert.equal(notice.reason, 'raw', 'the raw reason stays available')

  assert.deepEqual(registry.answer('chat-1', { verb: 'approve', id: notice.id }), {
    status: 'settled', id: notice.id, toolName: 'bash', outcome: 'allowed-once',
  })
  assert.equal(await pending, 'allowed-once')
  assert.equal(registry.size, 0)
  assert.equal(registry.answer('chat-1', { verb: 'deny', id: notice.id }).status, 'unknown', 'settled asks are gone')
}

// --- deny is the mirror decision ---------------------------------------------
{
  const { registry, notices } = harness()
  const pending = registry.forward('chat-1', '本会话', request(), never)
  registry.answer('chat-1', { verb: 'deny', id: notices[0].id })
  assert.equal(await pending, 'rejected')
  assert.equal(registry.size, 0)
}

// --- a raw reason passes through; no reason carries no field ------------------
{
  const { registry, notices } = harness()
  const pending = registry.forward('chat-1', '本会话', request({ reason: 'hook says ask' }), never)
  assert.equal(notices[0].reason, 'hook says ask')
  assert.ok(!('detail' in notices[0]), 'no localized detail without one')
  registry.answer('chat-1', { verb: 'approve', id: notices[0].id })
  await pending

  const bare = harness()
  const spare = bare.registry.forward('chat-1', '本会话', request(), never)
  assert.ok(!('reason' in bare.notices[0]), 'absent reason stays absent')
  bare.registry.dispose()
  assert.equal(await spare, 'cancelled')
}

// --- a card click settles the ask and remembers the card it came from -------
{
  const { registry, notices, resolved } = harness()
  const pending = registry.forward('chat-1', '本会话', request(), never)
  registry.attachCard(notices[0].id, 'om_card_1')
  assert.deepEqual(registry.resolveCard(notices[0].id, 'chat-1', true), {
    status: 'settled', id: notices[0].id, toolName: 'bash', outcome: 'allowed-once',
  })
  assert.equal(await pending, 'allowed-once')
  assert.deepEqual(resolved, [{ id: notices[0].id, messageId: 'om_card_1', resolution: 'allowed-once' }])
  assert.equal(registry.noticeOf(notices[0].id), undefined, 'settled asks expose no notice')
  assert.equal(registry.resolveCard(notices[0].id, 'chat-1', true).status, 'unknown')

  const foreign = harness()
  const foreignPending = foreign.registry.forward('chat-1', '本会话', request(), never)
  assert.equal(foreign.registry.resolveCard(foreign.notices[0].id, 'chat-2', true).status, 'foreign')
  foreign.registry.dispose()
  assert.equal(await foreignPending, 'cancelled')
}

// --- the deadline reports as timeout, not as a person's rejection -----------
{
  const { registry, notices, resolved } = harness({ timeoutMs: 20 })
  registry.forward('chat-1', '本会话', request(), never)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(notices.length, 1)
  assert.equal(resolved.at(-1).resolution, 'timeout')
  assert.equal(resolved.at(-1).messageId, undefined)
}

// --- the local chain can win the race ----------------------------------------
{
  const { registry, notices, expired } = harness({ timeoutMs: 20 })
  const pending = registry.forward('chat-1', '本会话', request(), async () => 'allowed-once')
  assert.equal(await pending, 'allowed-once')
  assert.equal(registry.size, 0)
  assert.equal(notices.length, 1)
  assert.equal(registry.answer('chat-1', { verb: 'approve', id: notices[0].id }).status, 'unknown')
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(expired.length, 0, 'the deadline was released when the local chain answered')
}

// --- a chat decision retracts a prompt the rest of the chain posted ----------
{
  const { registry, notices, expired } = harness({ timeoutMs: 20 })
  const asker = new AbortController()
  const request = { agent: { session: { id: 'session-1' } }, toolName: 'bash', signal: asker.signal }
  let posted
  // The desktop bridge ties its prompt — and its dismissal — to this signal,
  // so a retraction here is what closes the prompt without a local answer.
  const pending = registry.forward('chat-1', '本会话', request, () => new Promise((_, reject) => {
    posted = request.signal
    request.signal.addEventListener('abort', () => reject(new Error('prompt retracted')), { once: true })
  }))
  assert.notEqual(posted, asker.signal, 'the chain observes an owned lifetime, not the asker signal')
  assert.equal(posted.aborted, false)
  registry.answer('chat-1', { verb: 'approve', id: notices[0].id })
  assert.equal(await pending, 'allowed-once')
  assert.equal(posted.aborted, true, 'the forwarded prompt is retracted once the chat decides')
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(expired.length, 0, 'the retraction does not read as a timeout')
}

// --- the lifetime also ends when the local chain answers first ---------------
{
  const { registry } = harness()
  const request = { agent: { session: { id: 'session-1' } }, toolName: 'bash' }
  const pending = registry.forward('chat-1', '本会话', request, async () => 'rejected')
  assert.equal(await pending, 'rejected')
  assert.equal(request.signal.aborted, true, 'a decided ask leaves no lifetime open')
}

// --- the asker's own cancellation still reaches the chat ---------------------
{
  const { registry, notices } = harness()
  const asker = new AbortController()
  const request = { agent: { session: { id: 'session-1' } }, toolName: 'bash', signal: asker.signal }
  const pending = registry.forward('chat-1', '本会话', request, never)
  asker.abort()
  assert.equal(await pending, 'cancelled')
  assert.equal(request.signal.aborted, true)
  assert.equal(registry.size, 0)
  assert.equal(registry.answer('chat-1', { verb: 'approve', id: notices[0].id }).status, 'unknown')
}

// --- a frozen request still works, it just cannot be retracted ---------------
{
  const { registry, notices } = harness()
  const frozen = Object.freeze({ agent: { session: { id: 'session-1' } }, toolName: 'bash' })
  const pending = registry.forward('chat-1', '本会话', frozen, never)
  assert.equal(notices.length, 1)
  registry.answer('chat-1', { verb: 'approve', id: notices[0].id })
  assert.equal(await pending, 'allowed-once')
}

// --- withdrawal, both before and after the ask is visible --------------------
{
  const before = new AbortController()
  before.abort()
  const { registry, notices } = harness()
  const early = registry.forward('chat-1', '本会话', request({ signal: before.signal }), never)
  assert.equal(notices.length, 0, 'a withdrawn ask is not published')
  assert.equal(await early, 'cancelled')

  const after = new AbortController()
  const live = registry.forward('chat-1', '本会话', request({ signal: after.signal }), never)
  assert.equal(notices.length, 1)
  after.abort()
  assert.equal(await live, 'cancelled')
  assert.equal(registry.size, 0)
}

// --- silence is a rejection, and a late reply is not applied ------------------
{
  const { registry, notices, expired } = harness({ timeoutMs: 20 })
  const pending = registry.forward('chat-1', '本会话', request(), never)
  assert.equal(await pending, 'rejected')
  assert.equal(expired.length, 1)
  assert.equal(expired[0].id, notices[0].id)
  assert.equal(registry.answer('chat-1', { verb: 'approve', id: notices[0].id }).status, 'unknown')
}

// --- another chat cannot decide someone else's ask ---------------------------
{
  const { registry, notices } = harness()
  const pending = registry.forward('chat-1', '本会话', request(), never)
  assert.deepEqual(registry.answer('chat-2', { verb: 'approve', id: notices[0].id }), {
    status: 'foreign', toolName: 'bash',
  })
  assert.equal(registry.size, 1, 'a foreign reply leaves the ask pending')
  registry.answer('chat-1', { verb: 'deny', id: notices[0].id })
  assert.equal(await pending, 'rejected')
}

// --- no local decision must not end the wait --------------------------------
{
  const { registry, notices } = harness()
  const pending = registry.forward('chat-1', '本会话', request(), async () => 'unavailable')
  assert.equal(registry.size, 1, 'unavailable is silence, not a decision')
  assert.equal(registry.answer('chat-1', { verb: 'approve', id: notices[0].id }).status, 'settled')
  assert.equal(await pending, 'allowed-once')
}

// --- a throwing answerer must not leave the ask behind -----------------------
{
  const { registry, notices } = harness()
  const pending = registry.forward('chat-1', '本会话', request(), () => { throw new Error('boom') })
  assert.equal(registry.size, 1, 'a failing answerer leaves the chat in charge')
  assert.equal(registry.answer('chat-1', { verb: 'deny', id: notices[0].id }).status, 'settled')
  assert.equal(await pending, 'rejected')
}

// --- unmount withdraws every open ask ----------------------------------------
{
  const { registry, notices } = harness()
  const first = registry.forward('chat-1', '本会话', request(), never)
  const second = registry.forward('chat-2', '本会话', request({ toolName: 'fs' }), never)
  assert.equal(registry.size, 2)
  registry.dispose()
  assert.equal(await first, 'cancelled')
  assert.equal(await second, 'cancelled')
  assert.equal(registry.size, 0)
  assert.equal(notices.length, 2)
}

console.log('smoke-approval ok')
