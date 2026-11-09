import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contributeCheckForSession, writeContributeState } from '../contribute-check.js';
import { DefaultHooks } from '../default-hooks.js';
import { buildHandlerRegistry } from '../hook-handlers.js';
import { buildHintMessage as buildMrHint, type MRSummary } from '../mr-hint.js';
import { buildPackageHintMessage } from '../pkg/pkg-hint.js';
import { recordRecallQuality } from '../recall-quality.js';
import { buildHintMessage as buildTodoWriteHint } from '../todowrite-hint.js';
import type { LocalConfig } from '../types.js';

/**
 * The hint texts teamai's hooks print, captured from the handlers before their texts moved into hook folders
 * (#1787): with no team replacement, each must stay byte for byte what it was, for every `language` value.
 */
const GOLDEN: Record<string, Record<string, Record<Language, string>>> = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'default-hooks', 'golden.json'), 'utf8'),
);

type Language = 'unset' | 'en' | 'zh';

const LANGUAGES: readonly Language[] = ['unset', 'en', 'zh'];

const asOption = (language: Language): 'en' | 'zh' | undefined => (language === 'unset' ? undefined : language);

const MRS: MRSummary[] = [
  { id: '12', title: 'Retry the token refresh once', url: 'https://github.com/acme/api/pull/12', mergedAt: '2026-11-02T08:30:00Z' },
  { id: '15', title: 'Drop the v1 login endpoint', url: 'https://github.com/acme/api/pull/15', mergedAt: '2026-11-05T17:04:00Z' },
];

describe('hint texts before and after their move into hook folders', () => {
  let home: string;
  const originalHome = process.env.HOME;
  let session = 0;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hint-golden-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** A user scope whose team repo sets `language` as given. */
  function scopeIn(language: Language): LocalConfig {
    const repoPath = path.join(home, `team-${language}`);
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'teamai.yaml'), `team: golden\nrepo: https://example.com/golden.git\n${language === 'unset' ? '' : `language: ${language}\n`}`);

    return { repo: { localPath: repoPath, remote: 'https://example.com/golden.git' }, username: 't', scope: 'user', additionalRoles: [] };
  }

  /** The friction reminder in a scope whose team sets `language`, for a session whose cached score fires it. */
  async function frictionReminder(language: Language, { reasons, gap, task, offer }: { reasons: boolean; gap: boolean; task: boolean; offer: boolean }): Promise<string | null> {
    const sessionId = `golden-${session++}`;
    await writeContributeState(sessionId, {
      contributed: false,
      smartScore: 30,
      toolCount: 20,
      lastEvaluated: Date.now(),
      friction: reasons ? { interrupt: 2, toolReject: 1, correction: 3, toolError: 6 } : { interrupt: 0, toolReject: 0, correction: 0, toolError: 0 },
      promptSummary: task ? 'Fix the flaky login test' : undefined,
    });

    if (gap) recordRecallQuality(sessionId, [], 'login test retries');
    const offered = offer ? async () => ({ publish: true, scorers: [] }) : undefined;

    return (await contributeCheckForSession(sessionId, undefined, undefined, false, offered, scopeIn(language))).hint;
  }

  const FRICTION_CASES = [false, true].flatMap((gap) => [false, true].flatMap((reasons) => [false, true].flatMap((task) => [false, true].map((offer) => ({
    name: `${gap ? 'gap' : 'problem'}${reasons ? '-reasons' : ''}${task ? '-task' : ''}${offer ? '-share-learnings' : ''}`, gap, reasons, task, offer,
  })))));

  it.each(FRICTION_CASES)('friction reminder $name', async ({ name, ...shape }) => {
    for (const language of LANGUAGES) expect(await frictionReminder(language, shape)).toBe(GOLDEN['teamai-friction-reminder']?.[name]?.[language]);
  });

  it.each([
    { name: 'offer-command', offersWorkflow: false },
    { name: 'offer-workflow', offersWorkflow: true },
  ])('merged-MR hint $name', async ({ name, offersWorkflow }) => {
    const mrHint = await DefaultHooks.load('teamai-mr-hint', null);

    for (const language of LANGUAGES) expect(buildMrHint(MRS, mrHint, { language: asOption(language), offersWorkflow })).toBe(GOLDEN['teamai-mr-hint']?.[name]?.[language]);
  });

  it('TodoWrite hint', async () => {
    const todoWriteHint = await DefaultHooks.load('teamai-todowrite-hint', null);

    for (const language of LANGUAGES) expect(buildTodoWriteHint(todoWriteHint, asOption(language))).toBe(GOLDEN['teamai-todowrite-hint']?.message?.[language]);
  });

  it.each([
    { name: 'npm-and-plugin', counts: [2, 1, 0] },
    { name: 'one-npm', counts: [1, 0, 0] },
    { name: 'plugins-and-marketplace', counts: [0, 2, 1] },
    { name: 'all', counts: [3, 1, 2] },
  ] as const)('package hint $name', async ({ name, counts: [npm, claude, marketplace] }) => {
    const packageHint = await DefaultHooks.load('teamai-package-hint', null);

    for (const language of LANGUAGES) expect(buildPackageHintMessage(packageHint, { npm, claude, marketplace }, asOption(language))).toBe(GOLDEN['teamai-package-hint']?.[name]?.[language]);
  });

  /** The session-start env hint of a user scope whose team sets `language` and whose repo holds these env files. */
  async function envHint(language: Language, files: Record<string, string>): Promise<unknown> {
    const config = scopeIn(language);
    fs.mkdirSync(path.join(config.repo.localPath, 'env'), { recursive: true });

    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(config.repo.localPath, file), content);
    const hint = buildHandlerRegistry().find(({ handler }) => handler.name === 'team-env-hint');
    const output = await hint?.handler.execute({}, 'claude', config);

    return typeof output === 'string' ? (JSON.parse(output) as { hookSpecificOutput: { additionalContext: unknown } }).hookSpecificOutput.additionalContext : output;
  }

  const ENV_YAML = 'variables:\n  - key: API_URL\n    value: https://api.example.com\n    description: the staging API\n  - key: LOG_LEVEL\n    value: debug\n';
  const SECRETS_YAML = 'secrets:\n  - key: GITHUB_TOKEN\n    description: gh and the github MCP server\n  - key: SENTRY_AUTH_TOKEN\n';

  it.each<{ name: string; files: Record<string, string> }>([
    { name: 'variables', files: { 'env/env.yaml': ENV_YAML } },
    { name: 'secrets', files: { 'env/secrets.yaml': SECRETS_YAML } },
    { name: 'variables-and-secrets', files: { 'env/env.yaml': ENV_YAML, 'env/secrets.yaml': SECRETS_YAML } },
  ])('env hint $name', async ({ name, files }) => {
    for (const language of LANGUAGES) expect(await envHint(language, files)).toBe(GOLDEN['teamai-env-hint']?.[name]?.[language]);
  });
});
