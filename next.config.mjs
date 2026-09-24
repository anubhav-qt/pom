/**
 * The path the OMS is served under. paribelle.in rewrites `/pom` and
 * `/pom/:path*` to this deployment (a Vercel multi-zone), so every route,
 * asset and route handler lives behind this prefix.
 *
 * Re-exported as NEXT_PUBLIC_BASE_PATH below so the handful of places that
 * build a URL from a raw string can read it too. See src/lib/base-path.ts.
 */
const basePath = "/pom";

/** @type {import('next').NextConfig} */
const nextConfig = {
  /**
   * Emits .next/standalone: a server.js plus only the node_modules it traces
   * as used. The Docker image ships that instead of the full install. Vercel
   * ignores this setting, so the current deploy is unaffected.
   */
  output: "standalone",

  basePath,
  /**
   * Next already defaults assetPrefix to basePath, so this is the same value it
   * would pick on its own. Stated outright because a multi-zone setup depends
   * on it: assets have to be requested under the prefix or the storefront's
   * rewrite never sees them.
   */
  assetPrefix: basePath,

  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },

  experimental: {
    serverActions: {
      /**
       * The OMS runs on server actions almost end to end. Next checks the
       * request Origin against the Host, and behind a cross-zone rewrite those
       * disagree: the browser sends paribelle.in, the deployment sees its own
       * Vercel host. Without this every action fails with "Invalid Server
       * Actions request", which takes down every interaction in the app.
       */
      allowedOrigins: ["paribelle.in", "www.paribelle.in"],
    },
  },

  /**
   * These must stay out of the server bundle.
   *
   * pdfjs-dist in particular: when bundled, its fake-worker setup tries to
   * import `pdf.worker.mjs` from the chunk directory and fails at runtime. Kept
   * external it resolves from node_modules normally, which is the only way
   * label splitting works inside a route handler.
   */
  serverExternalPackages: ["pdf-lib", "xlsx", "pdfjs-dist"],

  /**
   * pdfjs loads its worker with a dynamic import it builds at runtime, which
   * Vercel's file tracing cannot see, so the file is missing from the deployed
   * function ("Cannot find module .../pdf.worker.mjs") and every PDF fails to
   * read. Ship it with the routes that read PDFs.
   */
  outputFileTracingIncludes: {
    "/api/label-print": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
    "/api/label-print/[id]": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
  },
};

export default nextConfig;
