import path from "node:path";
import type { NextConfig } from "next";

// The frontend imports shared code (hash helpers, generated ABIs, capability
// schemas) from ../agent-runtime/src/shared via the @shared alias. Turbopack
// only resolves files inside its root, so the root is the repo, one level up.
const repoRoot = path.join(__dirname, "..");

// Browser hardening for every page. The CSP only restricts framing, plugins,
// <base> and form targets, script and connect sources stay open because the
// wallet connectors and RPC endpoints load from many origins.
const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  // The browser end-to-end test (backend/src/frontend.solana.e2e.test.ts) builds into its own directory,
  // so it never replaces the .next of a person's own `next dev` or `next build`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  turbopack: {
    root: repoRoot,
  },
  outputFileTracingRoot: repoRoot,
  poweredByHeader: false,
  headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
