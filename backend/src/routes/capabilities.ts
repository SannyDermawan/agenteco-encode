import { Router } from 'express'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db.ts'
import { verifyOwnerAuth } from '../auth.ts'
import { getCapability, listCapabilities } from '../capabilityRegistry.ts'
import { CUSTOM_CAPABILITY_ID, registerCapabilitySchema } from '../../../agent-runtime/src/shared/capabilities/custom.ts'
import { normalizeWallet } from '../../../agent-runtime/src/shared/wallets.ts'

/**
 * The open capability registry. Public to read, a capability is a contract
 * between strangers, so its schemas and rubric are for everyone to see.
 * Publishing is signed by the developer's wallet and can't be undone or
 * edited: tasks commit to a capability, so a new version is a new id.
 */
export const capabilitiesRouter = Router()

capabilitiesRouter.get('/', async (req, res) => {
  res.json(await listCapabilities(req.query.sort === 'new' ? 'new' : 'top'))
})

capabilitiesRouter.get('/:id', async (req, res) => {
  const { id } = req.params
  if (!CUSTOM_CAPABILITY_ID.test(id)) return res.status(404).json({ error: 'Capability not found' })
  const capability = await getCapability(id)
  if (!capability) return res.status(404).json({ error: 'Capability not found' })
  res.json(capability)
})

capabilitiesRouter.post('/', async (req, res) => {
  const auth = await verifyOwnerAuth(req)
  if (!auth.ok) return res.status(401).json({ error: auth.error })

  const parsed = registerCapabilitySchema.safeParse(req.body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return res.status(400).json({ error: issue ? `${issue.path.join('.') || 'capability'}: ${issue.message}` : 'Invalid capability' })
  }
  if (await getCapability(parsed.data.id)) {
    return res.status(409).json({ error: `"${parsed.data.id}" is already published, capabilities are immutable, so publish a new id (e.g. "${parsed.data.id}_v2").` })
  }

  const row = await prisma.capability.create({
    data: {
      ...parsed.data,
      inputSchema: parsed.data.inputSchema as Prisma.InputJsonValue,
      outputSchema: parsed.data.outputSchema as Prisma.InputJsonValue,
      examples: parsed.data.examples as Prisma.InputJsonValue,
      ownerWallet: normalizeWallet(auth.wallet),
    },
  })
  res.status(201).json(await getCapability(row.id))
})
