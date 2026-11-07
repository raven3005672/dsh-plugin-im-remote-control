// Keyless image-input smoke: the inbound parser and the signature sniffing are
// what decide whether a Feishu attachment reaches the model, so they are
// asserted without Feishu or a mounted plugin.
import assert from 'node:assert/strict'

const { parseInbound } = await import('../lib/inbound.js')
const { sniffImageMediaType, MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE } = await import('../lib/images.js')

// --- plain text -------------------------------------------------------------
assert.deepEqual(parseInbound('text', JSON.stringify({ text: '你好' })), { text: '你好', imageKeys: [] })
assert.deepEqual(parseInbound(undefined, JSON.stringify({ text: 'fallback' })), { text: 'fallback', imageKeys: [] })
assert.deepEqual(parseInbound('text', 'not json'), { text: '', imageKeys: [] })
assert.deepEqual(parseInbound('text', JSON.stringify({})), { text: '', imageKeys: [] })
assert.deepEqual(parseInbound('file', JSON.stringify({ file_key: 'file_1' })), { text: '', imageKeys: [] })

// --- one image --------------------------------------------------------------
assert.deepEqual(parseInbound('image', JSON.stringify({ image_key: 'img_v3_1' })), { text: '', imageKeys: ['img_v3_1'] })
assert.deepEqual(parseInbound('image', JSON.stringify({})), { text: '', imageKeys: [] })

// --- rich text: title, paragraphs, inline image and link --------------------
{
  const content = JSON.stringify({
    zh_cn: {
      title: '标题',
      content: [
        [{ tag: 'text', text: '第一段 ' }, { tag: 'a', text: '链接', href: 'https://example.com' }],
        [{ tag: 'text', text: '看图：' }, { tag: 'img', image_key: 'img_a' }, { tag: 'img', image_key: 'img_b' }],
      ],
    },
  })
  assert.deepEqual(parseInbound('post', content), { text: '标题\n第一段 链接\n看图：', imageKeys: ['img_a', 'img_b'] })
}

// --- received post: bare body, no locale wrapper ---------------------------
{
  const content = JSON.stringify({
    title: '',
    content: [[{ tag: 'text', text: '看图：' }, { tag: 'img', image_key: 'img_c' }]],
  })
  assert.deepEqual(parseInbound('post', content), { text: '看图：', imageKeys: ['img_c'] })
}

// --- rich text falls back to en_us -----------------------------------------
{
  const content = JSON.stringify({ en_us: { content: [[{ tag: 'text', text: 'hello' }]] } })
  assert.deepEqual(parseInbound('post', content), { text: 'hello', imageKeys: [] })
}

// --- signatures -------------------------------------------------------------
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const gif = Uint8Array.from([...Buffer.from('GIF89a'), 0, 0])
const webp = Uint8Array.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP'), 0])
const bmp = Uint8Array.from([0x42, 0x4d, 0, 0])

assert.equal(sniffImageMediaType(png), 'image/png')
assert.equal(sniffImageMediaType(jpeg), 'image/jpeg')
assert.equal(sniffImageMediaType(gif), 'image/gif')
assert.equal(sniffImageMediaType(webp), 'image/webp')
assert.equal(sniffImageMediaType(bmp), undefined)
assert.equal(sniffImageMediaType(Uint8Array.from([])), undefined)
assert.equal(sniffImageMediaType(Uint8Array.from([0x89, 0x50])), undefined)

assert.equal(MAX_IMAGE_BYTES, 10 * 1024 * 1024)
assert.equal(MAX_IMAGES_PER_MESSAGE, 4)

console.log('smoke-images ok')
