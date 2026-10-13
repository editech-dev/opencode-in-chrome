/**
 * Frame codec — Chrome native messaging standard.
 * Frame = 4-byte UInt32LE length prefix + UTF-8 JSON body.
 * Used on stdin/stdout (extension ↔ host) and on the local socket (host ↔ MCP clients).
 */

import { MAX_INBOUND_MESSAGE, MAX_OUTBOUND_MESSAGE } from "./wire-protocol"

/** Incremental reader: feed raw chunks, get decoded JSON values as they complete. */
export class FrameReader {
  private buf: Buffer<ArrayBufferLike>

  constructor() {
    this.buf = Buffer.alloc(0)
  }

  /** Feed raw bytes; returns zero or more decoded values. Throws on malformed frames. */
  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    const out: unknown[] = []
    for (;;) {
      if (this.buf.length < 4) break
      const len = this.buf.readUInt32LE(0)
      if (len === 0 || len > MAX_INBOUND_MESSAGE) {
        throw new Error(`invalid frame length ${len}`)
      }
      if (this.buf.length < 4 + len) break
      const body = this.buf.subarray(4, 4 + len)
      this.buf = this.buf.subarray(4 + len)
      out.push(JSON.parse(body.toString("utf8")))
    }
    return out
  }
}

/** Encodes a value as a native-messaging frame (validates the 1 MiB host→Chrome cap). */
export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8")
  if (body.length > MAX_OUTBOUND_MESSAGE) {
    throw new Error(`frame exceeds host→Chrome limit (${body.length} > ${MAX_OUTBOUND_MESSAGE})`)
  }
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}
