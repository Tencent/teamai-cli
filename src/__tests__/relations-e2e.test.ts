/**
 * E2E for the #1552 first slice: declared asset relations reach `teamai recall`
 * output as `Related:` lines, `teamai contribute` warns and still publishes,
 * and `teamai review --branch` fails relations outside the declaration table.
 *
 * Runs the real CLI (dist/index.js) against a self-mode team repo built from
 * the example in the #1552 triage comment.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-relations-e2e-'));
const remote = path.join(sandbox, 'remote.git');
const seed = path.join(sandbox, 'seed');
const teamRepo = path.join(sandbox, 'team-repo');
const projectRoot = path.join(sandbox, 'project');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
}

function run(args: string[], cwd: string, expectStatus = 0): string {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, FORCE_COLOR: '0' },
  });
  expect(result.status, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`).toBe(expectStatus);
  return result.stdout;
}

function writeTeamFiles(root: string): void {
  fs.mkdirSync(path.join(root, 'rules'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'release'), { recursive: true });
  fs.mkdirSync(path.join(root, 'teamwiki', 'evidence', 'code', 'pay', 'modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'rules', 'payments.md'), [
    '---',
    'related:',
    '  MAPS_TO: teamwiki/evidence/code/pay/modules/ledger-receipts.md',
    '  REFERENCES: [docs/payments-overview.md, skills/release]',
    '---',
    'Every payment goes through ledger receipts; no direct writes to ledger.',
    'The flow is in [the overview](../docs/payments-overview.md).',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'docs', 'payments-overview.md'), 'How the payment flow works.\n');
  fs.writeFileSync(path.join(root, 'skills', 'release', 'SKILL.md'), '---\nname: release\ndescription: Release workflow\n---\n\n# Release\n');
  fs.writeFileSync(path.join(root, 'teamwiki', 'evidence', 'code', 'pay', 'modules', 'ledger-receipts.md'), [
    '---', 'title: ledger-receipts', '---', '', '# Ledger receipts module', '',
  ].join('\n'));
}

beforeAll(() => {
  // The team repo, seeded with the example assets.
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), ['team: relations-e2e', `repo: ${remote}`, 'provider: git', 'reviewers: []'].join('\n'));
  writeTeamFiles(seed);
  git(['init', '-q', '-b', 'main'], seed);
  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', 'seed'], seed);
  git(['clone', '-q', '--bare', seed, remote], sandbox);

  // The member checkout and its project-scope config.
  fs.mkdirSync(projectRoot, { recursive: true });
  git(['clone', '-q', remote, teamRepo], projectRoot);
  fs.mkdirSync(path.join(projectRoot, '.teamai'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, '.teamai', 'config.yaml'),
    [
      'repo:',
      `  localPath: ${teamRepo}`,
      `  remote: ${remote}`,
      'username: ana',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${projectRoot}`,
    ].join('\n'),
  );
  run(['pull'], projectRoot);
}, 120_000);

afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('asset relations e2e (#1552 first slice)', () => {
  it('recall shows declared relations on both ends without changing hits, order or scores', () => {
    const withRelations = run(['recall', 'payments ledger'], projectRoot);

    const rulePath = path.join(teamRepo, 'rules', 'payments.md');
    const docPath = path.join(teamRepo, 'docs', 'payments-overview.md');
    const wikiPath = path.join(teamRepo, 'teamwiki', 'evidence', 'code', 'pay', 'modules', 'ledger-receipts.md');
    expect(withRelations).toContain(`Related: → MAPS_TO ${wikiPath}`);
    expect(withRelations).toContain(`Related: → REFERENCES ${docPath}`);
    expect(withRelations).toContain(`Related: → REFERENCES ${path.join(teamRepo, 'skills', 'release', 'SKILL.md')}`);
    // Declared REFERENCES beats the same link-derived relation.
    expect(withRelations.match(new RegExp(`Related: → REFERENCES ${docPath.replace(/[/.]/g, '\\$&')}`, 'g'))?.length).toBe(1);
    // The other ends answer with ←.
    expect(withRelations).toContain(`Related: ← MAPS_TO ${rulePath}`);

    // Ranking output is byte-identical once the Related: lines drop out.
    const strip = (s: string): string => s.split('\n').filter((l) => !l.startsWith('Related:')).join('\n');
    const baselineHits = strip(withRelations).split('\n').filter((l) => /^\[\d+\/\d+\]|^File:|Score:/.test(l));
    expect(baselineHits.length).toBeGreaterThan(0);

    // --check is unaffected.
    const check = run(['recall', '--check', 'payments ledger'], projectRoot);
    expect(check).toMatch(/RELEVANT|NOT_RELEVANT/);
  });

  it('contribute warns on relations outside the table and still publishes', () => {
    const learning = path.join(sandbox, 'ledger-timeout.md');
    fs.writeFileSync(learning, [
      '---',
      'title: "Ledger receipt write times out at 3s"',
      'author: ana',
      'date: 2026-10-12',
      'tags: [payments, ledger, troubleshooting]',
      'related:',
      '  SUPERSEDES: rules/payments.md',
      '  REFERENCES: docs/payment-overview.md',
      '---',
      'The receipt write times out at 3s; retry once.',
      '',
    ].join('\n'));
    const out = run(['contribute', '--file', learning, '--title', 'Ledger receipt write times out at 3s'], projectRoot);
    expect(out).toContain('⚠');
    expect(out).toContain('related: a learning cannot SUPERSEDES a rule (rules/payments.md). Use CONFLICTS_WITH; this relation is ignored.');
    expect(out).toContain('related: REFERENCES docs/payment-overview.md names no team asset; this relation is ignored.');
    expect(out).toContain('Your session knowledge has been shared with the team.');
  });

  it('review --branch fails relations outside the table on rules and docs', () => {
    const branch = 'fix/payments-related';
    // A retried test reuses the sandbox; a branch from the first attempt may
    // remain, with HEAD still on it.
    git(['checkout', '-q', 'main'], teamRepo);
    try { git(['branch', '-D', branch], teamRepo); } catch { /* not there */ }
    git(['checkout', '-q', '-b', branch, 'main'], teamRepo);
    fs.writeFileSync(path.join(teamRepo, 'rules', 'payments.md'), [
      '---',
      'related:',
      '  GOVERNS: teamwiki/evidence/code/pay/modules/ledger-receipts.md',
      '  IMPLEMENTS: docs/payments-overview.md',
      '  REFERENCES: docs/payment-overview.md',
      '---',
      'Every payment goes through ledger receipts; no direct writes to ledger.',
      '',
    ].join('\n'));
    git(['add', '-A'], teamRepo);
    git(['commit', '-q', '-m', 'declare relations'], teamRepo);

    const result = spawnSync(process.execPath, [CLI, 'review', '--branch', branch], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV, FORCE_COLOR: '0' },
    });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('[relations] rules/payments.md');
    expect(result.stdout + result.stderr).toContain('"GOVERNS" is not a relation. Use MAPS_TO, REFERENCES, SUPERSEDES or CONFLICTS_WITH.');
    expect(result.stdout + result.stderr).toContain('IMPLEMENTS relates code to code and cannot be declared on a rule.');
    expect(result.stdout + result.stderr).toContain('REFERENCES docs/payment-overview.md names no team asset on this branch; this relation is ignored.');
  });
});
