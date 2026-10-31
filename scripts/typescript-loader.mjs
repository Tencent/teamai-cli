import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
    const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    try {
      await fs.access(source);
      return { url: source.href, shortCircuit: true };
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !url.endsWith('.ts')) return nextLoad(url, context);
  const source = await fs.readFile(new URL(url), 'utf8');
  const compiled = await transform(source, { loader: 'ts', format: 'esm', target: 'node20', sourcefile: fileURLToPath(url), sourcemap: 'inline' });
  return { format: 'module', source: compiled.code, shortCircuit: true };
}
