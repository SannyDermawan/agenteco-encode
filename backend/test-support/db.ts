// Test harness: a throwaway in-memory Postgres (PGlite) behind a real Postgres socket, with
// the schema of prisma/schema.prisma applied. Point DATABASE_URL at `url` *before* importing
// anything that imports src/db.ts.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA = join(BACKEND, 'prisma', 'schema.prisma')

/** The SQL that creates the schema from nothing (cached per schema version — `prisma migrate diff` takes seconds). */
export function schemaSql(): string {
  const schema = readFileSync(SCHEMA, 'utf8')
  const key = createHash('sha256').update(schema).digest('hex').slice(0, 16)
  const dir = join(tmpdir(), 'agenteco-test-schema')
  const file = join(dir, `${key}.sql`)
  if (existsSync(file)) return readFileSync(file, 'utf8')
  const out = spawnSync(process.execPath, [join(BACKEND, 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'diff', '--from-empty', '--to-schema', SCHEMA, '--script'], {
    cwd: BACKEND,
    encoding: 'utf8',
  })
  if (out.status !== 0) throw new Error(`prisma migrate diff failed: ${out.stderr}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, out.stdout)
  return out.stdout
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

export interface TestDb {
  url: string
  /** Run raw SQL against the database (e.g. to inspect constraints). */
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>
  stop(): Promise<void>
}

export async function startTestDb(): Promise<TestDb> {
  const db = await PGlite.create()
  await db.exec(schemaSql())
  const port = await freePort()
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port, maxConnections: 50 })
  await server.start()
  return {
    url: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`,
    query: async <T,>(sql: string) => (await db.query<T>(sql)).rows,
    async stop() {
      await server.stop()
      await db.close()
    },
  }
}
