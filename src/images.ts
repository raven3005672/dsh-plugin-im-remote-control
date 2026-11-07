/**
 * Image helpers for inbound Feishu attachments.
 *
 * Feishu reports a media type per resource, but the value can be missing or
 * wrong (an encrypted CDN may say `application/octet-stream`). The bytes are the
 * authority: the Host only accepts PNG/JPEG/GIF/WebP, so this module sniffs the
 * signature and refuses anything else.
 *
 * @module dsh-plugin-im-remote-control/images
 */
import type { ImageMediaType } from './types.ts'

/** Largest image this plugin forwards; the Host may enforce a tighter bound. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** Most images attached from one message; extras are reported, never dropped silently. */
export const MAX_IMAGES_PER_MESSAGE = 4

/** Read the image signature; undefined for anything the Host cannot display. */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png'
  }
  // JPEG SOI followed by any marker.
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6) {
    const head = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0, bytes[4] ?? 0, bytes[5] ?? 0)
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  }
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0)
    const webp = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0)
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp'
  }
  return undefined
}
