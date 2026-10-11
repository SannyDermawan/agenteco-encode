import { defineConfig } from 'tsup'

// One plain-JavaScript file: the SDK sources (which ship as TypeScript) are bundled in, so `npx` needs
// no tsx. Dependencies stay external and are installed by npm.
export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  splitting: false,
  external: ['viem', 'zod', '@modelcontextprotocol/sdk', '@solana/kit'],
  noExternal: [/agent-runtime/],
})
