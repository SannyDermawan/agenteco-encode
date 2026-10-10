import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Io } from '../src/io.ts'
import { scrub } from '../src/io.ts'

export interface Captured {
  io: Io
  out: string[]
  err: string[]
  all(): string
}

/** An Io that records what a command prints, over its own temporary home. */
export function captured(home: string, env: NodeJS.ProcessEnv = {}, extra: Partial<Io> = {}): Captured {
  const out: string[] = []
  const err: string[] = []
  const secrets = new Set<string>()
  const io: Io = {
    env: { ...env, AGENTECO_HOME: home },
    home,
    secrets,
    interactive: false,
    out: (line) => out.push(scrub({ secrets }, line)),
    err: (line) => err.push(scrub({ secrets }, line)),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
    now: () => new Date(),
    ...extra,
  }
  return { io, out, err, all: () => [...out, ...err].join('\n') }
}

export function tempHome(): { home: string; cleanup(): void } {
  const home = mkdtempSync(join(tmpdir(), 'agenteco-cli-'))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

/** Every file under a directory, as [relative path, text] — to prove a secret is only where it belongs. */
export function filesUnder(dir: string, base = dir): [string, string][] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path, base) : [[path.slice(base.length + 1).replaceAll('\\', '/'), readFileSync(path, 'utf8')] as [string, string]]
  })
}
