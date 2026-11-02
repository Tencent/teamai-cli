import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { upgradeCodebaseWiki } from '../codebase-upgrade-wiki.js';
import { log } from '../utils/logger.js';

const roots: string[] = [];
const CJK = /[\u3400-\u9fff]/u;

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function legacyWiki(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-wiki-upgrade-'));
  roots.push(root);
  const repos = path.join(root, 'docs', 'team-codebase', 'repos');
  fs.mkdirSync(repos, { recursive: true });
  fs.writeFileSync(path.join(repos, 'ready.md'), '---\nsource: https://github.com/acme/ready.git\n---\n');
  fs.writeFileSync(path.join(repos, 'missing-source.md'), '# Missing source');
  return root;
}

describe('codebase wiki upgrade output', () => {
  it('prints an English dry-run summary', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => lines.push(args.join(' ')));
    vi.spyOn(log, 'info').mockImplementation((message) => lines.push(message));
    vi.spyOn(log, 'success').mockImplementation((message) => lines.push(message));

    await upgradeCodebaseWiki({ cwd: legacyWiki(), dryRun: true });

    const output = lines.join('\n');
    expect(output).toContain('migrated 1 repository to teamwiki/ format');
    expect(output).toContain('ready → teamai import --from-repo https://github.com/acme/ready.git');
    expect(output).toContain('missing-source: missing source/repo_url field');
    expect(output).not.toMatch(CJK);
  });

  it('keeps skipped reasons in JSON output English', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    await upgradeCodebaseWiki({ cwd: legacyWiki(), dryRun: true, json: true });

    const result = JSON.parse(output.join('')) as { migrated: string[]; skipped: string[] };
    expect(result.migrated).toEqual(['ready → teamai import --from-repo https://github.com/acme/ready.git']);
    expect(result.skipped).toEqual(['missing-source: missing source/repo_url field']);
    expect(output.join('')).not.toMatch(CJK);
  });
});
