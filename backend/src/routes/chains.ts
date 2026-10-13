import { Router } from 'express'
import { chainSummaries } from '../chains.ts'

export const chainsRouter = Router()

/** The chains this API serves, contract, token and explorer of each; the default one first. */
chainsRouter.get('/', (_req, res) => {
  res.json(chainSummaries())
})
