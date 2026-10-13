/**
 * Platform paths for the local bridge socket/pipe.
 *
 * Lessons baked in (from the Claude Code Windows incidents):
 *  - user names may contain emoji/spaces → sanitize before building pipe names;
 *  - Windows named pipes (`\\.\pipe\...`) and filesystem paths are separate
 *    namespaces — never mix them.
 */

import { homedir, platform, userInfo } from "node:os"
import { join } from "node:path"

export type RuntimePlatform = "linux" | "darwin" | "win32" | "other"

export function currentPlatform(): RuntimePlatform {
  const p = platform()
  if (p === "linux" || p === "darwin" || p === "win32") return p
  return "other"
}

/** Keeps only printable ASCII (drops emoji/unicode/spaces at the edges). */
export function sanitizeForPipeName(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, "").trim() || "default"
}

/** Directory that holds this user's per-process sockets (0700, inside the user dir). */
export function bridgeDir(): string {
  const p = currentPlatform()
  if (p === "win32") {
    return join(process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "oc-chrome", "bridge")
  }
  const runtime = process.env["XDG_RUNTIME_DIR"]
  if (runtime && runtime.length > 0) return join(runtime, "oc-chrome")
  return join(homedir(), ".local", "state", "oc-chrome", "bridge")
}

/** Socket path for a host process pid (unix socket or Windows named pipe). */
export function socketPathForPid(pid: number): string {
  const p = currentPlatform()
  if (p === "win32") {
    let user = "default"
    try {
      user = sanitizeForPipeName(userInfo().username)
    } catch {
      user = sanitizeForPipeName(process.env["USERNAME"] ?? "default")
    }
    return `\\\\.\\pipe\\oc-chrome-bridge-${user}-${pid}`
  }
  return join(bridgeDir(), `bridge-${pid}.sock`)
}

/** Where the bridge stores its own state (pairing token, last extension id). */
export function bridgeConfigDir(): string {
  const p = currentPlatform()
  if (p === "win32") {
    return join(process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "oc-chrome")
  }
  if (p === "darwin") {
    return join(homedir(), "Library", "Application Support", "oc-chrome")
  }
  return join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "oc-chrome")
}
