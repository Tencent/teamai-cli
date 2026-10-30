import { Parser } from 'acorn';
import { defineConfig, type Options } from 'tsup';

// V8 keeps a source holding any non-ASCII character as two bytes per
// character, so one em dash made every run decode the 5.5 MB bundle into
// 11 MB of UTF-16, then hash, compile and collect it: about 9 ms of each
// command's start. esbuild's ASCII charset escapes strings, templates and
// identifiers, but not regular expressions or the comments it keeps. Escape
// those too (`\uXXXX` means the same character in both, and a surrogate pair
// stays one code point under the `u` flag), and fail the build on anything left.
const NON_ASCII = /[\u0080-\uffff]/g;
const asciiOutput: NonNullable<Options['plugins']>[number] = {
  name: 'ascii-output',
  renderChunk(code, chunk) {
    if (!code.match(NON_ASCII)) return;
    const spans: Array<[number, number]> = [];
    Parser.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
      onComment: (_block, _text, start, end) => spans.push([start, end]),
      onToken: (token) => {
        if (token.type.label === 'regexp') spans.push([token.start, token.end]);
      },
    });
    let ascii = '';
    let at = 0;
    for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) {
      ascii += code.slice(at, start) + code.slice(start, end).replace(NON_ASCII, (char, offset: number, span: string) => {
        if (span[offset - 1] === '\\') throw new Error(`ascii-output: an escaped non-ASCII character at ${chunk.path}:${start + offset} needs a manual \\u escape`);
        return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
      });
      at = end;
    }
    ascii += code.slice(at);
    const left = ascii.search(NON_ASCII);
    if (left !== -1) throw new Error(`ascii-output: non-ASCII character outside a comment or regular expression in ${chunk.path}: ${JSON.stringify(ascii.slice(left - 40, left + 40))}`);
    return { code: ascii };
  },
};

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
  plugins: [asciiOutput],
  banner: {
    // `require` for the CommonJS dependencies bundled into this ES module.
    js: "#!/usr/bin/env node\nimport { createRequire as __teamaiCreateRequire } from 'node:module';\nconst require = __teamaiCreateRequire(import.meta.url);",
  },
});
