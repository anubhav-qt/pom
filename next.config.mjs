/** @type {import('next').NextConfig} */
const nextConfig = {
  /**
   * These must stay out of the server bundle.
   *
   * pdfjs-dist in particular: when bundled, its fake-worker setup tries to
   * import `pdf.worker.mjs` from the chunk directory and fails at runtime. Kept
   * external it resolves from node_modules normally, which is the only way
   * label splitting works inside a route handler.
   */
  serverExternalPackages: ["pdf-lib", "xlsx", "pdfjs-dist"],
};

export default nextConfig;
