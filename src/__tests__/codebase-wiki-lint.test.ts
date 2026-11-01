import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatWikiLintReport, lintTeamwiki } from '../codebase-wiki-lint.js';

const roots: string[] = [];
const CJK = /[\u3400-\u9fff]/u;

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempWiki(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-wiki-lint-'));
  roots.push(root);
  return root;
}

describe('codebase wiki lint output', () => {
  it('reports missing wiki assets in English', async () => {
    const output = formatWikiLintReport(await lintTeamwiki({ wikiRoot: tempWiki() }));

    expect(output).toContain('=== teamwiki/ knowledge graph health check ===');
    expect(output).toContain('graph-index.json does not exist; the knowledge graph has not been built');
    expect(output).toContain('The evidence directory does not exist; no code fact pages are available');
    expect(output).toContain('Total: 2 high, 0 medium, 4 low, 0 info');
    expect(output).not.toMatch(CJK);
  });

  it('reports a healthy wiki in English', async () => {
    const wiki = tempWiki();
    fs.mkdirSync(path.join(wiki, '.indices'), { recursive: true });
    fs.mkdirSync(path.join(wiki, 'evidence', 'code', 'project'), { recursive: true });
    fs.writeFileSync(path.join(wiki, '.indices', 'graph-index.json'), JSON.stringify({
      nodes: [{ slug: 'project' }],
      edges: [{ from: 'project', to: 'project' }],
    }));
    fs.writeFileSync(path.join(wiki, 'evidence', 'code', 'project', 'index.md'), '# Project');
    for (const file of ['router.md', 'index.md', 'hot.md']) fs.writeFileSync(path.join(wiki, file), '');
    fs.writeFileSync(path.join(wiki, 'source-manifest.json'), JSON.stringify({ lastScan: new Date().toISOString() }));

    const output = formatWikiLintReport(await lintTeamwiki({ wikiRoot: wiki }));

    expect(output).toContain('Graph: 1 nodes, 1 edges, connectivity 100%');
    expect(output).toContain('✓ No issues');
    expect(output).not.toMatch(CJK);
  });
});
