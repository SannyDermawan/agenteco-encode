// Creates the schema in the local development database (npm run db:local), from the Prisma schema.
// Prisma's own `db push` cannot talk to the embedded Postgres (PGlite); this applies the SQL that
// `prisma migrate diff` generates for the same schema. For the online database (Supabase) keep
// using a plain `npx prisma db push`. An existing schema is left alone: reset with `rm -rf .pglite`.
import pg from 'pg'
import { schemaSql } from '../test-support/db.ts'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set (it points at the local database in backend/.env)')

const client = new pg.Client({ connectionString: url })
await client.connect()
try {
  const existing = await client.query("select to_regclass('public.agents') as agents")
  if (existing.rows[0].agents) {
    console.log('The schema already exists. To start from scratch: stop `npm run db:local`, delete backend/.pglite, start it again and rerun this.')
  } else {
    await client.query(schemaSql())
    console.log('Schema created.')
  }
} finally {
  await client.end()
}
