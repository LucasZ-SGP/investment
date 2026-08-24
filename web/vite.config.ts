import { defineConfig } from "vite";

// base is overridden at build time for GitHub Pages, where the site is served
// from /<repo>/ rather than the domain root.
export default defineConfig({
  base: process.env.PAGES_BASE ?? "/",
  build: {
    target: "es2022",
    // Everything ships as one bundle: no CDN, no dynamic remote imports, so the
    // page satisfies a strict CSP and there is no third-party script that could
    // ever read the GitHub token out of storage.
    rollupOptions: { output: { manualChunks: undefined } },
  },
});
