/**
 * oc-chrome-bridge CLI — one-time installer (decision D10).
 *
 *   oc-chrome-bridge install [--ext-id <chrome-extension-id>]
 *   oc-chrome-bridge uninstall
 *   oc-chrome-bridge status
 *   oc-chrome-bridge doctor
 *
 * `install` writes the NativeMessagingHosts manifest for every Chromium-family
 * browser profile found on the platform, registering the wrapper that Chrome will
 * spawn. After install, Chrome spawns the host automatically — zero scripts per use.
 */

import { execFile } from "node:child_process"
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { connect } from "node:net"
import { fileURLToPath } from "node:url"
import {
  HOST_NAME,
  bridgeConfigDir,
  bridgeDir,
  currentPlatform,
  encodeFrame,
  socketPathForPid,
} from "@opencode-in-chrome/shared"

const VERSION = "0.1.0-alpha"
const HERE = dirname(fileURLToPath(import.meta.url))
const HOST_TS = join(HERE, "native-host", "host.ts")

function out(msg: string): void {
  console.log(msg)
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

function run(cmd: string, args: string[], timeoutMs = 5_000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: stdout ?? "" }),
    )
  })
}

/** Locates a command's ABSOLUTE path (Chrome spawns hosts with a minimal env —
 *  a bare `bun` in the wrapper resolves nothing: lesson from the mcp-chrome wrappers). */
async function locate(cmd: string): Promise<string | null> {
  const finder = currentPlatform() === "win32" ? "where" : "which"
  const { code, stdout } = await run(finder, [cmd])
  if (code !== 0) return null
  return stdout.trim().split(/\r?\n/)[0] ?? null
}

/** Prefers bun (plan D3); falls back to node (Node ≥ 23.6 runs TS natively). */
async function resolveRunner(): Promise<{ cmd: string; fullPath: string }> {
  for (const cmd of ["bun", "node"]) {
    const p = await locate(cmd)
    if (!p) continue
    const v = await run(p, ["--version"])
    if (v.code === 0) return { cmd, fullPath: p }
  }
  fail("neither bun nor node was found on PATH — install bun ≥1.4: https://bun.com/install")
}

function manifestTargets(plat: ReturnType<typeof currentPlatform>): { browser: string; file: string }[] {
  const h = homedir()
  const name = `${HOST_NAME}.json`
  if (plat === "win32") {
    return [{ browser: "chrome", file: join(bridgeConfigDir(), name) }]
  }
  if (plat === "darwin") {
    const base = join(h, "Library", "Application Support")
    return [
      { browser: "chrome", file: join(base, "Google", "Chrome", "NativeMessagingHosts", name) },
      { browser: "chromium", file: join(base, "Chromium", "NativeMessagingHosts", name) },
      { browser: "brave", file: join(base, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts", name) },
      { browser: "edge", file: join(base, "Microsoft Edge", "NativeMessagingHosts", name) },
    ]
  }
  const cfg = process.env["XDG_CONFIG_HOME"] ?? join(h, ".config")
  return [
    { browser: "chrome", file: join(cfg, "google-chrome", "NativeMessagingHosts", name) },
    { browser: "chromium", file: join(cfg, "chromium", "NativeMessagingHosts", name) },
    { browser: "brave", file: join(cfg, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts", name) },
  ]
}

async function writeManifest(file: string, hostPath: string, allowedOrigins: string[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(
    file,
    JSON.stringify(
      {
        name: HOST_NAME,
        description: "OpenCode in Chrome — native messaging host",
        path: hostPath,
        type: "stdio",
        allowed_origins: allowedOrigins,
      },
      null,
      2,
    ) + "\n",
  )
}

async function cmdInstall(argv: string[]): Promise<void> {
  const plat = currentPlatform()

  // All --ext-id flags (union): the WXT build changes the unpacked extension's
  // directory, hence its ID; allowing old + new keeps the current pairing alive.
  const argvIds: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--ext-id" && argv[i + 1]) {
      argvIds.push(argv[i + 1]!.trim())
      i++
    }
  }

  // Saved extension ids from a previous pairing (Fase 3 makes this automatic).
  const savedIds = (await readFile(join(bridgeConfigDir(), "ext-id"), "utf8").catch(() => ""))
    .trim()
    .split(",")
    .filter(Boolean)

  const ids = [...new Set([...argvIds, ...savedIds])]
  if (ids.length === 0) {
    fail(
      "missing --ext-id. Load the unpacked extension, copy its ID from chrome://extensions, " +
        "then run: oc-chrome-bridge install --ext-id <id> (repeat the flag to allow several builds)",
    )
  }
  await mkdir(bridgeConfigDir(), { recursive: true })
  await writeFile(join(bridgeConfigDir(), "ext-id"), `${ids.join(",")}\n`)
  const allowedOrigins = ids.map((id) => `chrome-extension://${id}/`)

  const runner = await resolveRunner()
  const hostDir = join(bridgeConfigDir(), "host")

  if (plat === "win32") {
    // Chrome spawns via cmd.exe: a .bat wrapper calling the runner directly.
    const hostBin = join(hostDir, "host.cmd")
    await mkdir(hostDir, { recursive: true })
    await writeFile(hostBin, `@echo off\r\n"${runner.fullPath}" run "${HOST_TS}"\r\n`, { mode: 0o755 })
    out(`  ✓ wrapper: ${hostBin}`)
    const manifestFile = manifestTargets(plat)[0]!.file
    await writeManifest(manifestFile, hostBin, allowedOrigins)
    out(`  ✓ chrome manifest: ${manifestFile}`)
    const { code } = await run("reg", [
      "add", `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
      "/ve", "/d", manifestFile, "/f",
    ])
    if (code !== 0) fail("could not write the Windows registry key (HKCU)")
    out(`  ✓ registry: HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`)
  } else {
    const hostBin = join(hostDir, "host.sh")
    await mkdir(hostDir, { recursive: true })
    await writeFile(hostBin, `#!/bin/sh\nexec "${runner.fullPath}" run "${HOST_TS}"\n`, { mode: 0o755 })
    out(`  ✓ wrapper: ${hostBin}`)
    for (const { browser, file } of manifestTargets(plat)) {
      await writeManifest(file, hostBin, allowedOrigins)
      out(`  ✓ ${browser} manifest: ${file}`)
    }
  }

  out("")
  out("✓ installed. Restart Chrome and open the extension — Chrome will spawn the host automatically.")
  out(`  runner: ${runner.cmd} → ${HOST_TS}`)
  out(`  sockets live in: ${bridgeDir()} (named bridge-<pid>.${currentPlatform() === "win32" ? "pipe" : "sock"})`)
}

async function cmdUninstall(): Promise<void> {
  for (const { file } of manifestTargets(currentPlatform())) {
    await rm(file, { force: true })
  }
  if (currentPlatform() === "win32") {
    await run("reg", ["delete", `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`, "/f"])
  }
  out("✓ manifests removed (Chrome picks it up on restart)")
}

async function cmdStatus(): Promise<void> {
  out(`platform:    ${currentPlatform()}`)
  out(`host entry:  ${HOST_TS}`)
  for (const { browser, file } of manifestTargets(currentPlatform())) {
    const present = await access(file).then(() => true, () => false)
    out(`manifest ${browser.padEnd(8)}: ${present ? "✓ installed" : "— not installed"}`)
  }
  const extId = (await readFile(join(bridgeConfigDir(), "ext-id"), "utf8").catch(() => "")).trim()
  out(`extension:   ${extId ? `paired (${extId})` : "not paired yet"}`)
  out(`bridge dir:  ${bridgeDir()}`)
}

/** doctor — probes known socket files for a live host (the M0 smoke check, by hand). */
async function cmdDoctor(): Promise<void> {
  const dir = bridgeDir()
  if (currentPlatform() === "win32") {
    out("doctor: Windows named pipes cannot be listed portably from userspace; run `status` + use the extension.")
    return
  }
  const { readdir } = await import("node:fs/promises")
  const entries = await readdir(dir).catch(() => [])
  const sockets = entries.filter((n) => /^bridge-\d+\.sock$/.test(n))
  out(`bridge dir: ${dir} (${sockets.length} socket(s))`)
  let alive = 0
  for (const s of sockets) {
    const responded = await new Promise<boolean>((resolve) => {
      const c = connect(join(dir, s), () => c.write(encodeFrame({ type: "ping" })))
      c.setTimeout(2_000)
      c.on("data", () => {
        resolve(true)
        c.destroy()
      })
      c.on("timeout", () => {
        c.destroy()
        resolve(false)
      })
      c.on("error", () => resolve(false))
    })
    if (responded) alive++
    out(`  ${s}: ${responded ? "✓ alive (pong)" : "dead"}`)
  }
  out(alive > 0 ? "✓ live bridge found — the extension can connect" : "— no live bridge; open Chrome with the extension to spawn one")

  // MCP health (T16): entry file + OpenCode registration + node coverage.
  out("")
  const mcpEntry = join(HERE, "mcp.ts")
  const entryOk = await access(mcpEntry).then(() => true, () => false)
  out(`mcp server file: ${entryOk ? `✓ ${mcpEntry}` : "✗ missing (reinstall the bridge)"}`)
  const opencodePaths = [
    join(homedir(), ".config", "opencode", "opencode.jsonc"),
    join(homedir(), ".config", "opencode", "opencode.json"),
    join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "opencode", "opencode.jsonc"),
  ]
  let registered: string | null = null
  for (const cfgFile of opencodePaths) {
    const text = await readFile(cfgFile, "utf8").catch(() => "")
    if (/"oc-chrome"\s*:/.test(text)) registered = cfgFile
  }
  const projCfg = join(process.cwd(), "opencode.jsonc")
  if (!registered && /"oc-chrome"\s*:/.test(await readFile(projCfg, "utf8").catch(() => ""))) {
    registered = `${projCfg} (project)`
  }
  out(`mcp registration: ${registered ? `✓ in ${registered}` : "— not registered (run: bun run src/cli.ts mcp)"}`)

  const oc = await locate("opencode").then((p) => p)
  if (oc && registered && entryOk && alive > 0) {
    out("✓ MCP chain ready — try: opencode run \"open example.com in my tab group and read its title\"")
  }
}

/** mcp — registers the oc-chrome MCP server with OpenCode (T14). */
async function cmdMcp(argv: string[]): Promise<void> {
  const http = argv.includes("--http")
  const mcpEntry = join(HERE, "mcp.ts")
  await access(mcpEntry).then(
    () => true,
    () => false,
  ) || fail("mcp entrypoint missing — reinstall the bridge package")
  const oc = await locate("opencode")
  if (!oc) {
    out("opencode is not on PATH — run this yourself:")
    out(`  opencode mcp add oc-chrome -- ${await resolveRunner().then((r) => r.fullPath)} run ${mcpEntry}`)
    return
  }
  const runner = await resolveRunner()
  const args = http
    ? ["mcp", "add", "oc-chrome", "--global", "--url", "http://127.0.0.1:9600/mcp"]
    : ["mcp", "add", "oc-chrome", "--global", "--", runner.fullPath, "run", mcpEntry]
  const { code, stdout } = await run(oc, args, 15_000)
  out(stdout.trim() || (code === 0 ? "✓ registered" : ""))
  if (code !== 0) fail("opencode mcp add failed — see output above")
  out("")
  out(http
    ? "⚠ HTTP mode needs the gateway running: bun run packages/bridge/src/mcp.ts --http"
    : "✓ global — `oc-chrome_*` tools work in every project (permissions: ask per action, see README)")
  const list = await run(oc, ["mcp", "list", "--log-level", "fatal"], 10_000)
  if (list.stdout.trim()) out(`\n${list.stdout.trim()}`)
}

const [, , command, ...argv] = process.argv
const commands: Record<string, (argv: string[]) => Promise<void>> = {
  install: cmdInstall,
  uninstall: cmdUninstall,
  status: cmdStatus,
  doctor: cmdDoctor,
  mcp: cmdMcp,
}

if (!command || command === "--help" || command === "help") {
  out(`oc-chrome-bridge ${VERSION} — connects OpenCode to your Chrome`)
  out("usage: oc-chrome-bridge <install|uninstall|status|doctor|mcp> [--ext-id <extension-id>]")
} else if (command === "--version" || command === "version") {
  out(`oc-chrome-bridge ${VERSION}`)
} else if (commands[command]) {
  commands[command]!(argv).catch((err: Error) => fail(err.message))
} else {
  fail(`unknown command "${command}" — try install | uninstall | status | doctor`)
}
