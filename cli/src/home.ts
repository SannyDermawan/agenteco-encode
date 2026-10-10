import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Everything the CLI keeps lives in one directory (default `~/.agenteco`, or AGENTECO_HOME):
 *   keys/<name>.json   the agent key (mode 0600)           never printed, never sent anywhere
 *   config.json        spend caps, API URL, default chain  written by the person
 *   state.json         the onboarding state (device link in progress, listings)
 *   spend.json         what jobs reserved today (the daily cap)
 *   jobs/<id>.json     one file per hire, so a restart resumes it
 */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTECO_HOME?.trim() || join(homedir(), '.agenteco')
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 })
}

/** Restrict a file to the current user: mode 0600 on POSIX, an ACL for the current user on Windows. */
export function restrictToUser(path: string): void {
  if (process.platform === 'win32') {
    try {
      const user = process.env.USERNAME ?? ''
      if (user) execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore' })
    } catch {
      // Best effort: the file is still in the user's own profile directory.
    }
  } else {
    chmodSync(path, 0o600)
  }
}

/** Whether another user could read this file (POSIX only; always false on Windows, where ACLs apply). */
export function isReadableByOthers(path: string): boolean {
  if (process.platform === 'win32') return false
  return (statSync(path).mode & 0o077) !== 0
}

/** JSON written whole or not at all: a crash never leaves half a file. */
export function writeJsonAtomic(path: string, value: unknown, secret = false): void {
  ensureDir(dirname(path))
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: secret ? 0o600 : 0o644 })
  if (secret) restrictToUser(tmp)
  renameSync(tmp, path)
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}
