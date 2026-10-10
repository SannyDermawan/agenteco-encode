import pkg from '../package.json' with { type: 'json' }

/** This CLI's version — also what onboard.md and the generated MCP configuration pin. */
export const VERSION: string = pkg.version
