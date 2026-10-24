import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('./', import.meta.url);
const output = new URL('dist/', root);
await mkdir(new URL('use-cases/', root), { recursive: true });
await rm(output, { recursive: true, force: true });
await mkdir(new URL('use-cases/', output), { recursive: true });
for (const name of ['index.html', 'styles.css', 'assets', 'use-cases']) {
  await cp(new URL(name, root), new URL(name, output), { recursive: true });
}
console.log(`Built website at ${fileURLToPath(output)}`);
