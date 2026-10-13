// Comma-separated, so the custom domain and the *.vercel.app URL can both call the API.
export const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean)

/** host[:port] of each frontend origin, the only domains a read session may name. */
export const FRONTEND_HOSTS = FRONTEND_ORIGINS.flatMap((origin) => {
  try {
    return [new URL(origin).host.toLowerCase()]
  } catch {
    return []
  }
})
