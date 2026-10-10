import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { startTestDb, type TestDb } from '../test-support/db.ts'

/** The multi-chain keys of the schema: escrow ids are unique per chain, not globally. */
let db: TestDb
let prisma: typeof import('./db.ts').prisma

before(async () => {
  db = await startTestDb()
  process.env.DATABASE_URL = db.url
  ;({ prisma } = await import('./db.ts'))
})

after(async () => {
  await prisma?.$disconnect()
  await db?.stop()
})

test('the same escrow id on two chains are two rows; twice on one chain is refused', async () => {
  const base = { capability: 'translation', result: {}, resultHash: '0x01' }
  await prisma.escrowResult.create({ data: { ...base, chainId: 'eip155:97', escrowId: '7' } })
  await prisma.escrowResult.create({ data: { ...base, chainId: 'eip155:84532', escrowId: '7' } })
  await assert.rejects(prisma.escrowResult.create({ data: { ...base, chainId: 'eip155:97', escrowId: '7' } }), /Unique constraint/)

  const found = await prisma.escrowResult.findUnique({ where: { chainId_escrowId: { chainId: 'eip155:84532', escrowId: '7' } } })
  assert.equal(found?.chainId, 'eip155:84532')
})

test('every escrow-keyed table is unique per (chain_id, escrow_id)', async () => {
  const rows = await db.query<{ table: string; columns: string }>(`
    select t.relname as table, string_agg(a.attname, ',' order by a.attname) as columns
    from pg_index i
    join pg_class t on t.oid = i.indrelid
    join pg_attribute a on a.attrelid = t.oid and a.attnum = any(i.indkey)
    where i.indisunique and not i.indisprimary
    group by t.relname, i.indexrelid
    having bool_or(a.attname = 'escrow_id')`)
  const byTable = new Map(rows.map((r) => [r.table, r.columns]))
  for (const table of ['escrow_results', 'tasks', 'verifications', 'ratings', 'disputes', 'orders']) {
    assert.equal(byTable.get(table), 'chain_id,escrow_id', table)
  }
})

test('agents carry their chain, an optional cross-chain group and an ERC-8004 id', async () => {
  const groupId = '00000000-0000-4000-8000-000000000001'
  const common = { name: 'A', description: 'd', role: 'seller', price: 1, ownerWallet: '0xabc', groupId }
  await prisma.agent.create({ data: { ...common, chainId: 'eip155:97', erc8004AgentId: '12' } })
  await prisma.agent.create({ data: { ...common, chainId: 'eip155:84532' } })
  const group = await prisma.agent.findMany({ where: { groupId }, orderBy: { chainId: 'asc' } })
  assert.deepEqual(
    group.map((a) => [a.chainId, a.erc8004AgentId]),
    [
      ['eip155:84532', null],
      ['eip155:97', '12'],
    ]
  )
  await assert.rejects(prisma.agent.create({ data: { ...common, groupId: null } as never }), /chainId|chain_id/)
})
