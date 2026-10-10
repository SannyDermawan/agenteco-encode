/**
 * What a command prints to and reads from. Output goes through `scrub`, which replaces any secret
 * the process holds (the agent's private key) with a marker, so a bug elsewhere cannot print it.
 */
export interface Io {
  env: NodeJS.ProcessEnv
  home: string
  out(line: string): void
  err(line: string): void
  /** Whether stdin and stdout are a terminal (a person is at the keyboard). */
  interactive: boolean
  /** Reads one line from the person (only called when `interactive`). */
  ask?(question: string): Promise<string>
  sleep(ms: number): Promise<void>
  now(): Date
  /** Secrets to blank out of anything printed. */
  secrets: Set<string>
}

export function scrub(io: Pick<Io, 'secrets'>, text: string): string {
  let result = text
  for (const secret of io.secrets) {
    if (secret.length >= 16) result = result.split(secret).join('[secret hidden]')
  }
  return result
}

export function consoleIo(env: NodeJS.ProcessEnv, home: string): Io {
  const secrets = new Set<string>()
  const io: Io = {
    env,
    home,
    secrets,
    interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
    out: (line) => process.stdout.write(`${scrub(io, line)}\n`),
    err: (line) => process.stderr.write(`${scrub(io, line)}\n`),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
  }
  return io
}
