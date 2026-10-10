import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

// Runtime connection goes through the pooled DATABASE_URL (Supabase's
// PgBouncer transaction-mode pooler) — separate from prisma.config.ts,
// which the CLI uses with DIRECT_URL for migrations only.
// DB_POOL_MAX caps the connection pool (the in-memory test database serves one connection at a time).
const poolMax = Number(process.env.DB_POOL_MAX) || undefined
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL, ...(poolMax && { max: poolMax }) })

// agentWalletKey (a hosted agent's own encrypted private key) must never
// leave the server, even encrypted — omitted globally so no route can
// accidentally serialize it into an API response. escrowScanBlock is a
// host-only BigInt, which res.json() can't serialize anyway.
export const prisma = new PrismaClient({ adapter, omit: { agent: { agentWalletKey: true, escrowScanBlock: true } } })

// The only client allowed to read the real key — the host runtime signing on
// a hosted agent's behalf, and DELETE /agents/:id emptying its wallet back to
// the owner. Everything else uses `prisma` above.
export const prismaWithAgentKey = new PrismaClient({ adapter })
