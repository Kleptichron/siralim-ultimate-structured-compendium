import { defineConfig } from 'vite';

export default defineConfig({
  // Relative, not '/'. A GitHub project page serves from
  // https://<user>.github.io/<repo>/, so root-absolute asset URLs would 404 on
  // everything. './' also keeps the build working unchanged at a domain root
  // (a user page or a custom domain) and from the filesystem, without the repo
  // name being baked in anywhere.
  base: './',
  build: {
    // 3.8 MB of index.json in public/ is copied verbatim; without this Vite
    // warns about it on every build as though it were a bundling mistake.
    chunkSizeWarningLimit: 1024,
  },
});
