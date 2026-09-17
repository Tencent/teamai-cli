import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Files allowed to name the learnings directory themselves. Everything else
 * asks the accessor, because a call site that builds the path from its own base
 * does not fail when the data moves: it reads an empty directory, and recall
 * quietly returns less (#485).
 */
const ALLOWED = new Set([
  path.join(srcRoot, 'utils', 'learnings-roots.ts'),   // the accessor itself
  path.join(srcRoot, 'utils', 'learnings-publish.ts'), // writes into a worktree it owns
  path.join(srcRoot, 'utils', 'pending-learnings.ts'), // the queue, not a learnings root
  path.join(srcRoot, 'types.ts'),                      // the machine-local mirror getter
  path.join(srcRoot, 'init.ts'),                       // creates the empty skeleton
]);

/** A line may opt out by saying why, in place, so the reason is reviewable. */
const OPT_OUT = /\/\/ learnings-root ok: \S/;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('the learnings directory has one accessor', () => {
  it('is not rebuilt by hand anywhere else in src/', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(srcRoot)) {
      if (ALLOWED.has(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // The reason may sit on the line itself or on the one above it.
        if (OPT_OUT.test(line) || OPT_OUT.test(lines[i - 1] ?? '')) return;
        // path.join(<anything>, 'learnings') or a `${x}/learnings` template.
        if (/(?:path\.(?:join|resolve)\([^)]*|\$\{[^}]*\}\/)['"`]?learnings['"`]?\s*[,)]/.test(line)
          || /['"`]\/learnings['"`]/.test(line)) {
          offenders.push(`${path.relative(srcRoot, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
