/**
 * Parse the content of one inbound Feishu message.
 *
 * Feishu delivers text, image and rich-text (`post`) messages in one event. The
 * plugin only forwards text and images; anything else falls through as an empty
 * payload and is reported to the sender.
 *
 * @module dsh-plugin-im-remote-control/inbound
 */

/** What one message carries that the plugin can forward. */
export interface InboundPayload {
  /** Plain text, or the text extracted from a rich-text message. */
  readonly text: string
  /** Image keys, in message order; download them with the message resource API. */
  readonly imageKeys: readonly string[]
}

/** One element of a rich-text row. */
interface PostElement {
  readonly tag?: string
  readonly text?: string
  readonly image_key?: string
}

/** One rich-text body, per locale. */
interface PostBody {
  readonly title?: string
  readonly content?: readonly (readonly PostElement[])[]
}

/**
 * Read text and image keys from a message's `msg_type` and `content`.
 * @param msgType - Feishu message type (`text`, `image`, `post`, …).
 * @param raw - the event's JSON-encoded `content` string.
 * @returns the parts this plugin forwards; empty when the payload is unreadable.
 */
export function parseInbound(msgType: string | undefined, raw: string | undefined): InboundPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw ?? '{}')
  } catch {
    return { text: '', imageKeys: [] }
  }
  if (parsed === null || typeof parsed !== 'object') return { text: '', imageKeys: [] }

  if (msgType === 'image') {
    const key = (parsed as { image_key?: unknown }).image_key
    return { text: '', imageKeys: typeof key === 'string' && key !== '' ? [key] : [] }
  }

  if (msgType === 'post') {
    const post = parsed as { zh_cn?: PostBody; en_us?: PostBody }
    const body = post.zh_cn ?? post.en_us
    if (body === undefined) return { text: '', imageKeys: [] }
    const lines: string[] = []
    if (typeof body.title === 'string' && body.title !== '') lines.push(body.title)
    const imageKeys: string[] = []
    for (const row of body.content ?? []) {
      let line = ''
      for (const element of row) {
        if (element.tag === 'img') {
          if (typeof element.image_key === 'string' && element.image_key !== '') imageKeys.push(element.image_key)
          continue
        }
        if (typeof element.text === 'string') line += element.text
      }
      if (line !== '') lines.push(line)
    }
    return { text: lines.join('\n'), imageKeys }
  }

  const text = (parsed as { text?: unknown }).text
  return { text: typeof text === 'string' ? text : '', imageKeys: [] }
}
