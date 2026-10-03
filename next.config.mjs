/**
 * The path the OMS is served under. paribelle.in rewrites `/pom` and
 * `/pom/:path*` to this deployment (a Vercel multi-zone), so every route,
 * asset and route handler lives behind this prefix.
 *
 * Re-exported as NEXT_PUBLIC_BASE_PATH below so the handful of places that
 * build a URL from a raw string can read it too. See src/lib/base-path.ts.
 */
const basePath = "/pom";

/** Seelie's ffmpeg and canvas, for the routes that render or read media. */
const media = ["./node_modules/ffmpeg-static/ffmpeg*", "./node_modules/@napi-rs/canvas-linux-x64-gnu/**"];

/** The product studio's prompt templates and the watermark alpha maps, read from src/ at run time. */
const studio = ["./src/lib/seelie/studio/templates/**", "./src/lib/seelie/studio/watermark/**"];

/**
 * onnxruntime-node (Seelie's cut-outs) loads `bin/napi-v6/<platform>/<arch>/`'s binding,
 * which pulls in its shared library by itself: tracing sees neither. Only the ThinkPad's
 * Linux x64 build ships; on Vercel, where Seelie is offline, none of it does.
 */
const onVercel = !!process.env.VERCEL;
const onnx = onVercel ? [] : ["./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/**"];

/** MuPDF (Seelie's PDF tools) reads its wasm from beside its script by URL, which tracing doesn't follow. */
const mupdf = onVercel ? [] : ["./node_modules/mupdf/dist/mupdf.js", "./node_modules/mupdf/dist/mupdf-wasm.js", "./node_modules/mupdf/dist/mupdf-wasm.wasm"];

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

  /**
   * No "x-powered-by: Next.js" on every answer, and the headers a signed-in admin
   * tool needs: HTTPS only, never inside another site's frame (clickjacking), no
   * guessing file types, and only the origin in links out. Only the OMS's own pages
   * frame it (the PDF printer's demo).
   */
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },

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
   * Seelie's agent harness, a fork of pi kept in packages/ as npm workspaces.
   * They ship TypeScript source (with .ts import paths), so Next compiles them
   * like the app's own code.
   */
  transpilePackages: ["@paribelle/pi-ai", "@paribelle/pi-agent"],

  /**
   * These must stay out of the server bundle.
   *
   * pdfjs-dist in particular: when bundled, its fake-worker setup tries to
   * import `pdf.worker.mjs` from the chunk directory and fails at runtime. Kept
   * external it resolves from node_modules normally, which is the only way
   * label splitting works inside a route handler.
   */
  serverExternalPackages: ["pdf-lib", "xlsx", "pdfjs-dist", "@napi-rs/canvas", "ffmpeg-static", "onnxruntime-node", "nunjucks", "mupdf"],

  /**
   * pdfjs loads its worker with a dynamic import it builds at runtime, which
   * Vercel's file tracing cannot see, so the file is missing from the deployed
   * function ("Cannot find module .../pdf.worker.mjs") and every PDF fails to
   * read. Ship it with the routes that read PDFs.
   */
  outputFileTracingIncludes: {
    "/api/label-print": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
    "/api/label-print/[id]": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
    /**
     * Reels render inside this route: it needs the ffmpeg binary that
     * ffmpeg-static downloaded (a file no import points at), the canvas
     * library's native build for the deploy platform, and the brand's end card.
     */
    "/api/reels/[id]/run": [
      "./node_modules/ffmpeg-static/ffmpeg*",
      "./node_modules/@napi-rs/canvas-linux-x64-gnu/**",
      "./src/lib/reels/assets/**",
    ],
    /**
     * Seelie's tools run inside the request that started the reply: reels, renders,
     * cut-outs, photo edits and shoots (their prompt templates and the watermark maps
     * are read from src/ at run time). Uploads are read by ffmpeg as they arrive; an
     * image asset's small copy is drawn with the canvas. MuPDF (the PDF tools, and an
     * uploaded PDF's page count) loads its wasm from beside its script.
     */
    "/api/seelie/runs": [...media, ...onnx, "./src/lib/reels/assets/**", ...studio, ...mupdf],
    "/api/seelie/tool-calls": mupdf,
    "/api/seelie/assets": [...media, ...mupdf],
    "/api/seelie/assets/[id]": media,
  },

  outputFileTracingExcludes: {
    "*": onVercel
      ? ["./node_modules/onnxruntime-node/**"]
      : [
          "./node_modules/onnxruntime-node/bin/napi-v6/darwin/**",
          "./node_modules/onnxruntime-node/bin/napi-v6/win32/**",
          "./node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/**",
        ],
  },
};

export default nextConfig;
