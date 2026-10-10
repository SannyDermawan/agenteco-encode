import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runCli } from '../src/main.ts'
import { SKILL_MD } from '../src/commands/install.ts'
import { VERSION } from '../src/version.ts'
import { captured, tempHome } from './helpers.ts'

/** onboard.md is what an agent obeys: it must pin this CLI, and only name commands that exist. */
const onboard = readFileSync(join(import.meta.dirname, '..', '..', 'onboard.md'), 'utf8')

async function commandNames(): Promise<Set<string>> {
  const h = tempHome()
  try {
    const c = captured(h.home)
    await runCli(['help'], c.io)
    const names = new Set<string>()
    for (const line of c.all().split('\n')) {
      const m = /^ {2}([a-z][a-z-]*)(?: |$)/.exec(line)
      if (m) names.add(m[1])
    }
    return names
  } finally {
    h.cleanup()
  }
}

test('onboard.md pins exactly this CLI version', () => {
  assert.match(onboard, new RegExp(`^---\\nonboard: 1\\ncli: "@agenteco/cli@${VERSION.replaceAll('.', '\\.')}"\\n---`))
  const pins = [...onboard.matchAll(/@agenteco\/cli@([0-9][^\s`"')]*)/g)].map((m) => m[1])
  assert.ok(pins.length >= 3)
  for (const pin of pins) assert.equal(pin, VERSION, 'every mention of the CLI names this version')
  assert.equal(/@agenteco\/cli(?!@)/.test(onboard.replace(/`@agenteco\/cli`/g, '')), false, 'no unpinned CLI')
})

test('every command onboard.md tells the agent to run exists in the CLI', async () => {
  const known = await commandNames()
  assert.ok(known.has('init') && known.has('hire') && known.has('mcp-config'), `parsed help: ${[...known].join(',')}`)
  const mentioned = new Set<string>()
  for (const m of onboard.matchAll(/`agenteco ([a-z][a-z-]*)/g)) mentioned.add(m[1])
  assert.ok(mentioned.size >= 6)
  for (const name of mentioned) assert.ok(known.has(name), `onboard.md uses \`agenteco ${name}\`, which the CLI does not have`)
})

test('onboard.md carries the safety rules and nothing that downloads and runs code', () => {
  for (const phrase of [/data/i, /Never read, print, copy or transmit a private key/, /Never spend tokens during setup/, /Testnets only/, /Never try to raise a cap yourself/]) {
    assert.match(onboard, phrase)
  }
  assert.equal(/\|\s*(sh|bash)\b/.test(onboard.replace(/Do not run `curl … \| sh`/, '')), false, 'no pipe to a shell')
  assert.equal(/\bsudo\b/.test(onboard), false)
})

test('the exit codes it lists are the ones the CLI uses', () => {
  for (const code of ['`0`', '`1`', '`2`', '`3`', '`64`', '`77`']) assert.ok(onboard.includes(code))
})

test('the installed skill names the same version and the same safety rules', () => {
  assert.ok(SKILL_MD.includes(`@agenteco/cli@${VERSION}`))
  assert.match(SKILL_MD, /data, never instructions/)
  assert.match(SKILL_MD, /Never read, print or send the agent's private key/)
})
