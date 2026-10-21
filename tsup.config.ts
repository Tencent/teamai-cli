import { readFile } from 'node:fs/promises';
import { Parser } from 'acorn';
import { defineConfig, type Options } from 'tsup';
import type { Plugin } from 'esbuild';

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

// simple-git settles a command on `close`, or 50 ms after `exit` when `close`
// never comes (a grandchild such as an ssh ControlPersist master holding the
// pipe). That 50 ms timer is left running after `close` wins, so a command
// that ends on its own waited up to 50 ms after its last git call. Unref'd, it
// no longer holds the process; a held pipe still keeps it alive until it fires.
const SIMPLE_GIT_EXIT_FALLBACK = '(flag === true ? event.promise : event.promise.then(() => delay(flag))).then(timeout.done);';
const simpleGitExitFallbackUnref: Plugin = {
  name: 'simple-git-exit-fallback-unref',
  setup(build) {
    let patched = 0;
    build.onEnd((result) => {
      if (result.errors.length === 0 && patched === 0) throw new Error('simple-git exit fallback patch matched no file: re-check its filter in tsup.config.ts');
    });
    build.onLoad({ filter: /[\\/]simple-git[\\/]dist[\\/](esm|cjs)[\\/]index\.js$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      if (!source.includes(SIMPLE_GIT_EXIT_FALLBACK)) {
        throw new Error(`simple-git changed its completion plugin: re-check the exit fallback patch in tsup.config.ts (${args.path})`);
      }
      patched++;
      return {
        contents: source.replace(SIMPLE_GIT_EXIT_FALLBACK, '(flag === true ? event.promise : event.promise.then(() => new Promise((done) => setTimeout(done, flag).unref()))).then(timeout.done);'),
        loader: 'js',
      };
    });
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
  esbuildPlugins: [simpleGitExitFallbackUnref],
  plugins: [asciiOutput],
  banner: {
    // `require` for the CommonJS dependencies bundled into this ES module.
    js: "#!/usr/bin/env node\nimport { createRequire as __teamaiCreateRequire } from 'node:module';\nconst require = __teamaiCreateRequire(import.meta.url);",
  },
});
