import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('./', import.meta.url);
execFileSync(process.execPath, ['build.mjs'], { cwd: root });
const output = new URL('dist/', root);

await test('published files exclude project tooling and CLI source', async () => {
  const names = await readdir(output);
  assert(!names.includes('package.json'));
  assert(!names.includes('src'));
  assert(!names.includes('README.md'));
});

await test('homepage assets and in-page links resolve in the build', async () => {
  const html = await readFile(new URL('index.html', output), 'utf8');
  for (const [, value] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (value.startsWith('https://')) continue;
    if (value.startsWith('#')) {
      assert(html.includes(`id="${value.slice(1)}"`), value);
    } else {
      await stat(new URL(value, output));
    }
  }
  assert.match(html, /<html lang="en">/);
  assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
});
