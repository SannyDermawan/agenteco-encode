import { createInterface } from 'node:readline'
import { doctor } from './commands/doctor.ts'
import { init } from './commands/init.ts'
import { installSkill, mcpConfig } from './commands/install.ts'
import { hire, job } from './commands/jobs.ts'
import { caps, faucet, keyCommand } from './commands/misc.ts'
import { sell } from './commands/sell.ts'
import { status } from './commands/status.ts'
import { CliError, Ctx } from './ctx.ts'
import { homeDir } from './home.ts'
import { consoleIo, type Io } from './io.ts'
import { VERSION } from './version.ts'

const HELP = `agenteco ${VERSION}, hire and sell work between AI agents, with escrow, disputes and reputation.

Setup
  doctor                          check this machine and the network (read-only)
  init --role buyer|seller        create the agent key, link it to a person's account, show what to fund
  status                          address, link, listings, balances, open jobs
  faucet                          claim AgentEco's test token on BSC Testnet (needs a little gas)

Work
  hire --capability <id> --brief '<json>' --max-budget <n>     start a job and follow it
  job list | show <id> | wait <id> | settle <id> [--rating n] | dispute <id> --reason "…"
  sell --capability <id> --price <n> --handler <file.mjs>      serve a capability from this machine

Tools for agents
  mcp                             run the MCP server (stdio)
  mcp-config claude|claude-desktop|cursor|vscode [--write]
  install-skill [--dir <path>] [--force]

Safety
  caps                            show the spend caps (raising one needs a person at a terminal)
  key address                     the agent wallet's address (the private key is never printed)

Common options: --chain <name|id>   AGENTECO_HOME, AGENTECO_API_URL are read from the environment.
`

/**
 * Runs one command and returns its exit code: 0 done, 1 failed, 2 waiting for a person (run it
 * again), 3 still working (follow up), 64 bad usage, 77 refused (a cap, or a person is needed).
 */
export async function runCli(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv
  try {
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      io.out(HELP)
      return 0
    }
    if (command === 'version' || command === '--version' || command === '-v') {
      io.out(VERSION)
      return 0
    }
    const ctx = new Ctx(io, 'default')
    switch (command) {
      case 'doctor':
        return await doctor(ctx)
      case 'init':
        return await init(ctx, rest)
      case 'status':
        return await status(ctx)
      case 'faucet':
        return await faucet(ctx, rest)
      case 'hire':
        return await hire(ctx, rest)
      case 'job':
        return await job(ctx, rest)
      case 'sell':
        return await sell(ctx, rest)
      case 'caps':
        return await caps(ctx, rest)
      case 'key':
        return await keyCommand(ctx, rest)
      case 'install-skill':
        return await installSkill(ctx, rest)
      case 'mcp-config':
        return await mcpConfig(ctx, rest)
      case 'mcp': {
        const { serveMcp } = await import('./mcp.ts')
        await serveMcp(ctx)
        return 0
      }
      default:
        io.err(`Unknown command "${command}". Run \`agenteco help\`.`)
        return 64
    }
  } catch (error) {
    if (error instanceof CliError) {
      io.err(error.message)
      return error.code
    }
    io.err(`Error: ${(error as Error).message.split('\n')[0]}`)
    return 1
  }
}

/** The real process: console I/O, a prompt when a person is at the keyboard. */
export async function main(argv: string[]): Promise<number> {
  const io = consoleIo(process.env, homeDir())
  if (io.interactive) {
    io.ask = (question) =>
      new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout })
        rl.question(question, (answer) => {
          rl.close()
          resolve(answer)
        })
      })
  }
  return runCli(argv, io)
}
