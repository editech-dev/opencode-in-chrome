/**
 * check-dep-age.ts — supply-chain gate (decision D4)
 *
 * Fails if any dependency version resolved in bun.lock was published less than
 * MIN_AGE_MS ago on the npm registry. Covers manual `bun add` (Renovate's
 * minimumReleaseAge covers scheduled updates).
 *
 * Escape hatch (documented deviations only):
 *   OC_SKIP_DEP_AGE_CHECK=1 bun run check:dep-age
 *
 * Node/Bun compatible: only node:fs, node:process and global fetch.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

const MIN_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours
const REGISTRY = "https://registry.npmjs.org"

function fail(msg: string): never {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

function extractResolvedPackages(lockText: string): Map<string, string> {
  // bun.lock is JSONC with entries shaped "name": ["name@version", ...] (v2) or
  // "name": "name@version" (v1). A targeted regex handles both without a parser dep.
  const resolved = new Map<string, string>()
  const re = /"([a-zA-Z0-9@/_.-]+)@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(lockText)) !== null) {
    const name = m[1]
    const version = m[2]
    if (name === undefined || version === undefined) continue
    if (!resolved.has(name)) resolved.set(name, version)
  }
  return resolved
}

async function publishedAt(name: string, version: string): Promise<number | null> {
  const url = `${REGISTRY}/${encodeURIComponent(name).replace("%40", "@")}`
  // Full packument (plain JSON) — the abbreviated install-v1 format omits `time`.
  const res = await fetch(url, { headers: { accept: "application/json" } })
  if (!res.ok) return null
  const doc: unknown = await res.json()
  const time = (doc as { time?: Record<string, string> }).time
  const stamp = time?.[version]
  return stamp ? Date.parse(stamp) : null
}

const skip = process.env.OC_SKIP_DEP_AGE_CHECK === "1"
if (skip) {
  console.log("check-dep-age: skipped via OC_SKIP_DEP_AGE_CHECK=1 (documented deviation required)")
  process.exit(0)
}

const lockPath = join(process.cwd(), "bun.lock")
let lockText: string
try {
  lockText = readFileSync(lockPath, "utf8")
} catch {
  console.log("check-dep-age: no bun.lock — nothing to check")
  process.exit(0)
}

const resolved = extractResolvedPackages(lockText)
if (resolved.size === 0) {
  console.log("check-dep-age: no resolved packages in bun.lock")
  process.exit(0)
}

console.log(`check-dep-age: checking ${resolved.size} package(s) against a 24h minimum age…`)

const tooFresh: string[] = []
const unknown: string[] = []

const entries = [...resolved.entries()]
for (const [name, version] of entries) {
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
  if (Date.now() - stamp < MIN_AGE_MS) {
    tooFresh.push(`${name}@${version} (published ${ageH}h ago)`)
  } else {
    console.log(`  ✓ ${name}@${version} (${ageH}h old)`)
  }
}

if (unknown.length > 0) {
  fail(`could not verify publish date for: ${unknown.join(", ")} — resolve manually or pin an older version`)
}
if (tooFresh.length > 0) {
  fail(`versions younger than 24h are blocked by policy:\n  - ${tooFresh.join("\n  - ")}`)
}

console.log("check-dep-age: ✓ all dependencies are at least 24h old")
