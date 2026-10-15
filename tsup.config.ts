import { defineConfig } from 'tsup';

export default defineConfig({
  // `index` is the executable: it turns on Node's compile cache, then loads
  // `cli`, the CLI itself, which the cache can only cover as a separate file.
  entry: { index: 'src/bin.ts', cli: 'src/index.ts' },
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  // Dependencies go into the bundle too: loading each from node_modules
  // (resolve, read, compile) was about a third of a short command's startup,
  // and the compile cache covers one file whole. web-tree-sitter stays out:
  // it loads its .wasm from its own package directory.
  noExternal: [/^(?!web-tree-sitter$)/],
  banner: {
    // `require` for the CommonJS dependencies bundled into this ES module.
    js: "#!/usr/bin/env node\nimport { createRequire as __teamaiCreateRequire } from 'node:module';\nconst require = __teamaiCreateRequire(import.meta.url);",
  },
});
