// Local development database: an embedded Postgres (PGlite) kept in backend/.pglite and
// served on a Postgres socket, so the API, host and `prisma db push` use it like any other
// Postgres. Nothing to install, and `rm -rf .pglite` resets it.
//
//   npm run db:local                         (keep it running in its own terminal)
//   DATABASE_URL=DIRECT_URL=postgresql://postgres:postgres@127.0.0.1:54330/postgres?sslmode=disable
//   npx prisma db push                       (creates or updates the schema — never with --accept-data-loss)
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'

const PORT = Number(process.env.LOCAL_DB_PORT ?? 54330)
const dataDir = join(import.meta.dirname, '..', '.pglite')

const db = await PGlite.create({ dataDir })
const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: PORT, maxConnections: 50 })
await server.start()
console.log(`Local Postgres (PGlite, data in ${dataDir}) on postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`)

const shutdown = async () => {
  await server.stop()
  await db.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
