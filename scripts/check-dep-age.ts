/**
 * check-dep-age.ts — supply-chain gate (decision D4)
 *
 * Fails if any dependency version resolved in bun.lock was published less than
 * MIN_AGE_MS ago on the npm registry. This complements Bun's install-time
 * `minimumReleaseAge` gate: it also catches lockfile changes made with an older
 * Bun, with `--minimum-release-age=0`, or merged without re-resolving.
 *
 * Every resolved name@version is checked, including when the same package name
 * appears with several versions (bun.lock nests those under keys like
 * "htmlparser2/domhandler"). The lockfile is located by walking up from the
 * current directory, so the gate also works when invoked from a workspace.
 *
 * Escape hatch (documented deviations only):
 *   OC_SKIP_DEP_AGE_CHECK=1 bun run check:dep-age
 *
 * Node/Bun compatible: only node:fs, node:path, node:process and global fetch.
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const MIN_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours
const REGISTRY = "https://registry.npmjs.org"

export type ResolvedPackage = { name: string; version: string }

function fail(msg: string): never {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

export function extractResolvedPackages(lockText: string): ResolvedPackage[] {
  // bun.lock is JSONC with entries shaped "name": ["name@version", ...] (v2) or
  // "name": "name@version" (v1). The version string itself is the source of
  // truth, so nested keys for duplicate versions are handled naturally.
  const seen = new Set<string>()
  const resolved: ResolvedPackage[] = []
  const re = /"([a-zA-Z0-9@/_.-]+)@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(lockText)) !== null) {
    const name = m[1]
    const version = m[2]
    if (name === undefined || version === undefined) continue
    const key = `${name}@${version}`
    if (seen.has(key)) continue
    seen.add(key)
    resolved.push({ name, version })
  }
  return resolved
}

export function isTooFresh(publishedAtMs: number, nowMs = Date.now()): boolean {
  return nowMs - publishedAtMs < MIN_AGE_MS
}

export function findLockfile(startDir: string): string | null {
  let dir = startDir
  for (;;) {
    const candidate = join(dir, "bun.lock")
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export async function publishedAt(name: string, version: string): Promise<number | null> {
  const url = `${REGISTRY}/${encodeURIComponent(name).replace("%40", "@")}`
  // Full packument (plain JSON) — the abbreviated install-v1 format omits `time`.
  const res = await fetch(url, { headers: { accept: "application/json" } })
  if (!res.ok) return null
  const doc: unknown = await res.json()
  const time = (doc as { time?: Record<string, string> }).time
  const stamp = time?.[version]
  if (!stamp) return null
  const parsed = Date.parse(stamp)
  return Number.isNaN(parsed) ? null : parsed
}

async function main(): Promise<void> {
  const skip = process.env.OC_SKIP_DEP_AGE_CHECK === "1"
  if (skip) {
    console.log("check-dep-age: skipped via OC_SKIP_DEP_AGE_CHECK=1 (documented deviation required)")
    return
  }

  const lockPath = findLockfile(process.cwd())
  if (lockPath === null) {
    fail("no bun.lock found in this directory or its parents — run the gate from the repository")
  }

  let lockText: string
  try {
    lockText = readFileSync(lockPath, "utf8")
  } catch (err) {
    fail(`could not read ${lockPath}: ${(err as Error).message}`)
  }

  const resolved = extractResolvedPackages(lockText)
  if (resolved.length === 0) {
    fail(`no resolved packages found in ${lockPath}`)
  }

  console.log(
    `check-dep-age: checking ${resolved.length} package version(s) against a 24h minimum age…`,
  )

  const tooFresh: string[] = []
  const unknown: string[] = []

  for (const { name, version } of resolved) {
    let stamp: number | null = null
    try {
      stamp = await publishedAt(name, version)
    } catch (err) {
      console.error(`  ! registry lookup failed for ${name}@${version}: ${(err as Error).message}`)
      unknown.push(`${name}@${version}`)
      continue
    }
    if (stamp === null) {
      unknown.push(`${name}@${version}`)
      continue
    }
    const ageH = Math.floor((Date.now() - stamp) / 3_600_000)
    if (isTooFresh(stamp)) {
      tooFresh.push(`${name}@${version} (published ${ageH}h ago)`)
    } else {
      console.log(`  ✓ ${name}@${version} (${ageH}h old)`)
    }
  }

  if (unknown.length > 0) {
    fail(
      `could not verify publish date for: ${unknown.join(", ")} — resolve manually or pin an older version`,
    )
  }
  if (tooFresh.length > 0) {
    fail(`versions younger than 24h are blocked by policy:\n  - ${tooFresh.join("\n  - ")}`)
  }

  console.log("check-dep-age: ✓ all dependencies are at least 24h old")
}

if (import.meta.main) {
  await main()
}
