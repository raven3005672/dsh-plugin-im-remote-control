// Keyless quoted-reply routing smoke: a quote must reach the session that
// produced the quoted message, only within its own chat, and only while fresh.
import assert from 'node:assert/strict'

const { QuotedRoutes } = await import('../lib/replies.js')

const route = (sessionId = 'session-a', chatId = 'chat-1', label = '任务') => ({ sessionId, chatId, label })

// --- a remembered message is routable from its own chat ----------------------
{
  const routes = new QuotedRoutes(60_000, 10)
  routes.remember('om_1', route(), 1_000)
  assert.equal(routes.size, 1)
  assert.deepEqual(routes.take('om_1', 'chat-1', 2_000), { sessionId: 'session-a', chatId: 'chat-1', label: '任务', at: 1_000 })
  assert.equal(routes.take('om_1', 'chat-2', 2_000), undefined, 'a quote from another chat does not match')
  assert.equal(routes.take('om_missing', 'chat-1', 2_000), undefined)
  assert.deepEqual(routes.take('om_1', 'chat-1', 3_000), { sessionId: 'session-a', chatId: 'chat-1', label: '任务', at: 1_000 }, 'repeated quotes still route')
}

// --- an entry expires after its ttl -----------------------------------------
{
  const routes = new QuotedRoutes(1_000, 10)
  routes.remember('om_1', route(), 1_000)
  assert.ok(routes.take('om_1', 'chat-1', 1_500), 'still live inside the ttl')
  assert.equal(routes.take('om_1', 'chat-1', 2_100), undefined, 'the entry is gone once the ttl passes')
  assert.equal(routes.size, 0, 'expired entries are pruned on read')
}

// --- the oldest entries are dropped past the limit --------------------------
{
  const routes = new QuotedRoutes(60_000, 2)
  routes.remember('om_1', route('session-a'), 1_000)
  routes.remember('om_2', route('session-b'), 1_001)
  routes.remember('om_3', route('session-c'), 1_002)
  assert.equal(routes.size, 2)
  assert.equal(routes.take('om_1', 'chat-1', 1_003), undefined, 'the oldest entry was evicted')
  assert.equal(routes.take('om_2', 'chat-1', 1_003).sessionId, 'session-b')
  assert.equal(routes.take('om_3', 'chat-1', 1_003).sessionId, 'session-c')
}

// --- a label is optional ----------------------------------------------------
{
  const routes = new QuotedRoutes(60_000, 10)
  routes.remember('om_1', { sessionId: 'session-a', chatId: 'chat-1' }, 1_000)
  const hit = routes.take('om_1', 'chat-1', 1_100)
  assert.equal(hit.sessionId, 'session-a')
  assert.ok(!('label' in hit), 'no label when the result had none')
}

console.log('smoke-replies ok')
