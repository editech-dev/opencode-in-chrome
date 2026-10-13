/**
 * Wire protocol — the bridge between Chrome's native messaging, the local socket
 * and MCP clients.
 *
 * Framing (Chrome native messaging standard): every message is a UTF-8 JSON
 * document preceded by a 32-bit unsigned integer length in little-endian order.
 * Chrome → host limit: 64 MiB. Host → Chrome limit: 1 MiB.
 *
 * Corrections over the "Claude in Chrome" wire design (documented in specs/03):
 *  - every tool request carries a correlation `id` (the original is serialized,
 *    one call in flight, no request ids);
 *  - message shapes are narrow types, validated at the boundary;
 *  - session scope is explicit: { sessionId, tabGroupId }.
 */

export const HOST_NAME = "com.opencodeinchrome.bridge"
export const PROTOCOL_VERSION = 1

/** Chrome → host cap (docs): 64 MiB. */
export const MAX_INBOUND_MESSAGE = 64 * 1024 * 1024
/** Host → Chrome cap (docs): 1 MiB — keep a safety margin. */
export const MAX_OUTBOUND_MESSAGE = 1024 * 1024 - 8

// ── Extension ↔ host control messages ────────────────────────────────────────

export type PingMsg = { type: "ping" }
export type PongMsg = { type: "pong"; timestamp: number }
export type GetStatusMsg = { type: "get_status" }
export type StatusResponseMsg = {
  type: "status_response"
  nativeHostVersion: string
  hostPid: number
  socketPath: string
  mcpClients: number
  extensionConnected: boolean
}

// ── Host ↔ extension lifecycle broadcasts ────────────────────────────────────

export type McpConnectedMsg = { type: "mcp_connected"; clientId: string }
export type McpDisconnectedMsg = { type: "mcp_disconnected"; clientId: string }

// ── Tool calls (the actual work) ─────────────────────────────────────────────

/** Scopes every tool call to one agent session and its Chrome tab group. */
export type SessionScope = {
  sessionId: string
  tabGroupId?: number
}

export type ToolRequestMsg = {
  type: "tool_request"
  id: string
  tool: string
  args: unknown
  clientId: string
  sessionScope?: SessionScope
}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }

export type ToolResponseMsg = {
  type: "tool_response"
  id: string
  ok: true
  result: { content: ToolContent[] }
} | {
  type: "tool_response"
  id: string
  ok: false
  error: { message: string; content?: ToolContent[] }
}

export type NotificationMsg = {
  type: "notification"
  event: "session_started" | "permission_required" | "task_completed" | "error"
  payload?: unknown
}

// ── Unions ───────────────────────────────────────────────────────────────────

export type ChromeToHostMsg = PingMsg | GetStatusMsg | ToolResponseMsg | NotificationMsg
export type HostToChromeMsg =
  | PongMsg
  | StatusResponseMsg
  | McpConnectedMsg
  | McpDisconnectedMsg
  | ToolRequestMsg

export type SocketClientMsg = ToolRequestMsg | { type: "ping" }
export type HostToClientMsg = ToolResponseMsg | NotificationMsg | PongMsg

// ── Minimal boundary validation (zod lands in Fase 1 with the tool catalog) ──

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x)
}

/** Narrow guard used by the native host before trusting a Chrome message. */
export function isChromeToHostMsg(x: unknown): x is ChromeToHostMsg {
  if (!isRecord(x)) return false
  switch (x["type"]) {
    case "ping":
    case "get_status":
      return true
    case "tool_response":
      // ok:true carries `result`; ok:false carries `error` — both are valid shapes.
      return typeof x["id"] === "string" && (isRecord(x["result"]) || isRecord(x["error"]))
    case "notification":
      return typeof x["event"] === "string"
    default:
      return false
  }
}

/** Narrow guard used by the native host before forwarding a socket-client request. */
export function isToolRequestMsg(x: unknown): x is ToolRequestMsg {
  return (
    isRecord(x) &&
    x["type"] === "tool_request" &&
    typeof x["id"] === "string" &&
    typeof x["tool"] === "string" &&
    typeof x["clientId"] === "string"
  )
}

export function toolError(msg: ToolRequestMsg, message: string): ToolResponseMsg {
  return { type: "tool_response", id: msg.id, ok: false, error: { message } }
}
