import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sourceImport } from './imports.js';

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** A temporary directory holding `files`, returned with the forward slashes a rule's `lintedPath` gives it. */
const fixture = (...files: string[]): string => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-source-import-'));

  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'export {};\n');
  }

  return root.split(path.sep).join('/');
};

describe('sourceImport', () => {
  it('resolves a .js specifier to the .ts source beside it', () => {
    const dir = fixture('src/facts.ts', 'src/detect.ts');

    expect(sourceImport(`${dir}/src/facts.ts`, './detect.js')).toBe(`${dir}/src/detect.ts`);
  });

  it('resolves a directory specifier to its index.ts', () => {
    const dir = fixture('src/facts.ts', 'src/adapters/index.ts');

    expect(sourceImport(`${dir}/src/facts.ts`, './adapters/index.js')).toBe(`${dir}/src/adapters/index.ts`);
  });

  it('leaves a package specifier to the workspace, answering nothing', () => {
    const dir = fixture('src/facts.ts');

    expect(sourceImport(`${dir}/src/facts.ts`, '@teamai/tool-core/definition')).toBeUndefined();
  });

  it('answers with forward slashes on every platform, as the rules compare it with path.posix paths', () => {
    const dir = fixture('src/facts.ts', 'src/detect.ts');
    const file = sourceImport(`${dir}/src/facts.ts`, './detect.js');

    // `path.resolve`, which resolves the specifier, answers with the platform's separators: on Windows the
    // result would never match the `packages/<name>/src/<module>.ts` a rule builds from the repository root.
    expect(file).not.toContain('\\');
  });
});
