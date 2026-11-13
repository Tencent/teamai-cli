import { execFileSync } from 'node:child_process';
import type { AgentObservation } from '../agent-observation.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mocks.home, default: { ...actual, homedir: () => mocks.home } };
});
// The team's reports checkout is refreshed from origin before a pushed session is read; these fixtures have no origin.
vi.mock('../utils/reports-branch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/reports-branch.js')>();
  const { getReportsDir } = await import('../types.js');
  return { ...actual, readableReportsWorktree: async (config: Parameters<typeof getReportsDir>[0]) => getReportsDir(config) };
});

import { getReportsDir, type LocalConfig } from '../types.js';
import type { Session } from '@teamai/tool-core/sessions/ir';
import { defaultSyncMeta, getRepoIdentity, SyncManager } from '../session-flow/sync.js';
import { localAliasesPath } from '../models/aliases.js';
import { parseScoreLabels } from '../scorers/label.js';
import { LabelStore } from '../scorers/label-store.js';
import { syncScorerDefinitions } from '../scorers/cache.js';
import { encodeCwdClaude } from '@teamai/tool-core/sessions/fs';
import { projectDataHome } from '../utils/partition.js';
import { AGENT_SESSION_ENV } from '../utils/session-id.js';
import { tryScorer } from './helpers/score-run.js';
import { getTeamSecretsPath, writeSecretStore } from '../secret-store.js';
import type { WorkflowEnvelope } from '../workflow/types.js';
import * as cliPaths from '../utils/cli-path.js';
import { whileLabelsLocked } from './helpers/label-lock.js';
import { CONFINED_TOOLS } from '../tool-launch/tools.js';

const SCORER = `---
labels:
  - { value: good, score: 1, description: Did the work }
  - { value: bad, score: 0, description: Did not }
passingScore: 0.5
samplingRate: 0
---
Judge the session.
`;

const SESSION = '7c1e0000-0000-4000-8000-000000000001';

let root = '';
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-session-scoring-')));
  vi.spyOn(cliPaths, 'resolveCliPath').mockImplementation((cmd) => {
    const executable = path.join(root, 'bin', cmd);
    return fs.existsSync(executable) ? executable : null;
  });
  mocks.home = path.join(root, 'home');
  fs.mkdirSync(path.join(mocks.home, '.claude', 'projects'), { recursive: true });
  for (const name of AGENT_SESSION_ENV) vi.stubEnv(name, '');
  vi.stubEnv('HOME', mocks.home);
  vi.stubEnv('USERPROFILE', mocks.home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function data(envelope: WorkflowEnvelope): Record<string, unknown> {
  if ('error' in envelope) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
  return envelope.data;
}

async function fixture(scorers: Record<string, string> = { quality: SCORER }, kind: 'self' | 'git' | 'http' = 'self'): Promise<LocalConfig> {
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'scorers'), { recursive: true });
  for (const [name, text] of Object.entries(scorers)) fs.writeFileSync(path.join(knowledge, 'scorers', `${name}.md`), text);
  const config: LocalConfig = {
    repo: { localPath: knowledge, remote: 'local', kind },
    username: 'tester', scope: 'user', additionalRoles: [], dataHome: path.join(root, 'data'),
  };
  await syncScorerDefinitions(config);
  return config;
}

const line = (record: unknown): string => `${JSON.stringify(record)}\n`;

function plantClaudeSession(cwd: string, prompt: string): void {
  const project = path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd));
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, `${SESSION}.jsonl`),
    line({ type: 'user', uuid: 'u1', parentUuid: null, cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: prompt } })
    + line({ type: 'assistant', uuid: 'u2', parentUuid: 'u1', cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:01.000Z',
      message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Added the retries.' }] } }));
}

function plantSubagentEdit(cwd: string): void {
  const dir = path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd), SESSION, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-a.meta.json'), JSON.stringify({ toolUseId: 'toolu_1', spawnDepth: 1 }));
  fs.writeFileSync(path.join(dir, 'agent-a.jsonl'),
    line({ type: 'user', uuid: 'a1', parentUuid: null, isSidechain: true, message: { role: 'user', content: 'Add the retry loop' } })
    + line({ type: 'assistant', uuid: 'a2', parentUuid: 'a1', isSidechain: true,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_9', name: 'Edit', input: { file_path: 'src/client.ts', new_string: 'retryWithBackoff()' } }] } }));
}

/**
 * A Claude judge on PATH that answers as model `m1`, with `{ answer: { label: answer } }` or the batch answer it is given, keeps the
 * prompt file and the transcript file of its first call, on the whole session, in `<root>/judged.md` and
 * `<root>/judged-transcript.md`, the files it could read then in `<root>/judged-files.json`, the transcript file of its call `n` in `<root>/transcript-<n>.md`, and counts its calls
 * in `<root>/calls`.
 */
function fakeClaude(answer: string | Record<string, unknown>, version = '2.1.308 (Claude Code)'): void {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(); }
const at = process.argv.indexOf('--append-system-prompt-file');
const transcript = require('node:path').join('transcripts', 'session.md');
const calls = ${JSON.stringify(path.join(root, 'calls'))};
const call = (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').length : 0) + 1;
if (call === 1) fs.copyFileSync(process.argv[at + 1], ${JSON.stringify(path.join(root, 'judged.md'))});
if (call === 1) fs.copyFileSync(transcript, ${JSON.stringify(path.join(root, 'judged-transcript.md'))});
if (call === 1) fs.writeFileSync(${JSON.stringify(path.join(root, 'judged-files.json'))}, JSON.stringify(fs.readdirSync('.', { recursive: true }).sort()));
fs.copyFileSync(transcript, ${JSON.stringify(root)} + '/transcript-' + call + '.md');
fs.appendFileSync(calls, 'x');
process.stdin.resume(); process.stdin.on('end', () => {
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'm1' }));
console.log(JSON.stringify({ type: 'result', structured_output: ${JSON.stringify({ answer: typeof answer === 'string' ? { label: answer, reasoning: 'the reasoning' } : answer })} }));
});\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
}

const DRAFT = SCORER.replace('Judge the session.', 'Judge the session strictly.');

/** The draft `<name>.md` under `<root>/<dir>`, with `<root>` the current directory, and the scope's store as it is. */
function draft(text = DRAFT, name = 'quality', dir = 'draft'): { file: string; store: () => string[] } {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, `${name}.md`), text);
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const scores = path.join(root, 'data', 'scores');
  return {
    file: `./${dir}/${name}.md`,
    store: () => ['labels.jsonl', 'pending', 'reasoning'].map((entry) => {
      const at = path.join(scores, entry);
      if (!fs.existsSync(at)) return '';
      return fs.statSync(at).isDirectory() ? fs.readdirSync(at).join(',') : fs.readFileSync(at, 'utf8');
    }),
  };
}

/** The scorer file `<root>/draft/quality.md`, holding `text`. */
const quality = (text = SCORER): string => draft(text).file;

/**
 * A member scope in `~/.teamai` whose team repo is `kind` and holds the scorers, the session planted in `<root>/app`
 * under it, and the config of another scope, which has none of them.
 */
async function scopedElsewhere(kind: 'self' | 'http'): Promise<{ userHome: string; elsewhere: LocalConfig }> {
  const knowledge = (await fixture()).repo.localPath;
  const userHome = path.join(mocks.home, '.teamai');
  fs.mkdirSync(userHome, { recursive: true });
  fs.writeFileSync(path.join(userHome, 'config.yaml'), `repo:\n  localPath: ${knowledge}\n  remote: local\n  kind: ${kind}\nusername: tester\nscope: user\nadditionalRoles: []\n`);
  await syncScorerDefinitions({ repo: { localPath: knowledge, remote: 'local', kind }, username: 'tester', scope: 'user', additionalRoles: [] });
  plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
  fakeClaude('good');
  const elsewhere: LocalConfig = {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project',
    projectRoot: path.join(root, 'elsewhere'), additionalRoles: [], dataHome: path.join(root, 'elsewhere-data'),
  };
  return { userHome, elsewhere };
}

describe('teamai score --session', () => {
  const labelsFile = (): string => path.join(root, 'data', 'scores', 'labels.jsonl');

  it('judges a Claude session with a scorer file and prints its label, storing none', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    fakeClaude('good');

    expect(data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [quality()] }))).toMatchObject({
      label: { scorer: 'quality', file: 'draft/quality.md', subject: { platform: 'claude-code', sessionId: SESSION }, label: 'good', score: 1, passed: true, stored: false },
    });
    expect(fs.existsSync(labelsFile())).toBe(false);
    expect(fs.readFileSync(path.join(root, 'judged-transcript.md'), 'utf8')).toContain('Add retries to the client');
  });

  it('names a scorer file outside the current directory by its absolute path', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    fakeClaude('good');
    quality();
    const outside = path.join(root, 'elsewhere', 'quality.md');
    fs.mkdirSync(path.dirname(outside));
    fs.writeFileSync(outside, SCORER);
    vi.mocked(process.cwd).mockReturnValue(path.join(root, 'draft'));

    expect(data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [outside] }))).toMatchObject({ label: { scorer: 'quality', file: outside } });
  });

  it('holds the judge, and says why, when the scorer\'s alias has no model for any judge tool here', async () => {
    const config = await fixture();
    fs.mkdirSync(path.join(config.repo.localPath, 'models'));
    fs.writeFileSync(path.join(config.repo.localPath, 'models', 'aliases.yaml'), 'aliases:\n  fast:\n    codebuddy: cb-model\n');
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    fakeClaude('good');
    vi.stubEnv('PATH', [path.join(root, 'bin'), '/usr/bin', '/bin'].join(path.delimiter));

    expect(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [quality(SCORER.replace('samplingRate: 0', 'samplingRate: 0\nmodel: fast'))] })).toEqual({ error: {
      code: 'confined_pending',
      message: expect.stringContaining('asks for model alias "fast", which has no model for claude in models/aliases.yaml.'),
    } });
    expect(fs.existsSync(path.join(root, 'calls'))).toBe(false);
  });

  it('holds the judge, and says why, when the member\'s ~ entry turns the scorer\'s alias off', async () => {
    const config = await fixture();
    fs.mkdirSync(path.join(config.repo.localPath, 'models'));
    fs.writeFileSync(path.join(config.repo.localPath, 'models', 'aliases.yaml'), 'aliases:\n  fast:\n    claude: haiku\n');
    fs.mkdirSync(path.dirname(localAliasesPath()), { recursive: true });
    fs.writeFileSync(localAliasesPath(), 'aliases:\n  fast:\n    claude: ~\n');
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    fakeClaude('good');

    expect(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [quality(SCORER.replace('samplingRate: 0', 'samplingRate: 0\nmodel: fast'))] })).toEqual({ error: {
      code: 'confined_pending',
      message: expect.stringContaining(`asks for model alias "fast", which ${localAliasesPath()} turns off for claude.`),
    } });
    expect(fs.existsSync(path.join(root, 'calls'))).toBe(false);
  });

  it('names only the files a session evidence directory holds', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    fakeClaude('good');

    data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [quality()] }));
    const files: unknown = JSON.parse(fs.readFileSync(path.join(root, 'judged-files.json'), 'utf8'));
    expect(files).toEqual(expect.arrayContaining(['evidence.json', path.join('transcripts', 'session.md')]));
    expect(files).not.toContain('diff.patch');
  });

  it('never guesses the session: outside any session and without --session it fails before any judge runs', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    fakeClaude('good');

    expect(await tryScorer(config, { scorers: [quality()] })).toEqual({
      error: { code: 'session_required', message: 'Pass --session <id>; scoring never guesses the session.' },
    });
    expect(fs.existsSync(path.join(root, 'calls'))).toBe(false);
  });

  it('scores the session whose agent variable is set, without --session or --source', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    fakeClaude('good');
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', SESSION);

    expect(data(await tryScorer(config, { scorers: [quality()] }))).toMatchObject({
      label: { subject: { platform: 'claude-code', sessionId: SESSION }, label: 'good' },
    });
  });

  it('asks for --source when nothing names the platform of --session, and lists the platforms that hold it', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    fakeClaude('good');

    expect(await tryScorer(config, { session: SESSION, scorers: [quality()] })).toEqual({
      error: { code: 'source_required', message: expect.stringMatching(/^Pass --source with --session .*Found in: claude-code\.$/) },
    });
    expect(fs.existsSync(path.join(root, 'judged.md'))).toBe(false);
  });

  it('takes the platform of --session from its captures when they name exactly one', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    const dir = path.join(root, 'data', 'sessions', 'captures', 'claude-code', SESSION);
    fs.mkdirSync(dir, { recursive: true });
    const captureId = '0b6f2a52-5d7e-4c7e-9a43-6a3c1d0e2f01';
    fs.writeFileSync(path.join(dir, `${captureId}.json`), JSON.stringify({ captureId, platform: 'claude-code', sessionId: SESSION,
      capturedAt: '2026-10-20T10:00:00.000Z', agent: { v: 1, tool: { name: 'claude' }, teamai: '1.0.0', driver: 'session' } }));
    fakeClaude('good');

    expect(data(await tryScorer(config, { session: SESSION, scorers: [quality()] }))).toMatchObject({
      label: { subject: { platform: 'claude-code', sessionId: SESSION } },
    });
  });

  it('gives the judge the tool calls of the subagents the session started', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    plantSubagentEdit(path.join(root, 'app'));
    fakeClaude('good');

    data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [quality()] }));
    expect(fs.readFileSync(path.join(root, 'judged-transcript.md'), 'utf8')).toMatch(/## Subagent \(depth 1[^)]*\)[\s\S]*\[tool_call\] edit_file .*retryWithBackoff/);
  });

  it('fails without a label when no tool here can judge', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    const empty = path.join(root, 'empty-bin');
    fs.mkdirSync(empty);
    vi.stubEnv('PATH', empty);

    expect(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [quality()] })).toEqual({
      error: { code: 'judge_tool_unavailable', message: `No installed tool can run a scorer judge with every tool turned off. Install one teamai runs confined: ${CONFINED_TOOLS.join(', ')}.` },
    });
    expect(CONFINED_TOOLS).toEqual(expect.arrayContaining(['claude', 'codex', 'opencode', 'codebuddy', 'cursor', 'pi', 'agy']));
  });

  it('refuses a Codex id that is the end of two sessions\' ids, names both, and runs no judge', async () => {
    const config = await fixture();
    const ids = ['019a0000-0000-7000-8000-0000000000bb', '019b0000-0000-7000-9000-0000000000bb'];
    const day = path.join(mocks.home, '.codex', 'sessions', '2026', '10', '20');
    fs.mkdirSync(day, { recursive: true });
    for (const [index, id] of ids.entries()) {
      fs.writeFileSync(path.join(day, `rollout-2026-10-20T12-00-0${index}-${id}.jsonl`), [
        { type: 'session_meta', payload: { id, timestamp: '2026-10-20T10:00:00.000Z', cwd: path.join(root, `app-${index}`) } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Work on app ${index}` }] } },
      ].map(line).join(''));
    }
    fakeClaude('good');

    expect(await tryScorer(config, { session: '0000000000bb', source: 'codex', scorers: [quality()] })).toEqual({
      error: { code: 'session_ambiguous', message: `--session 0000000000bb names more than one codex session: ${ids.join(', ')}. Pass the whole id of one.` },
    });
    expect(fs.existsSync(path.join(root, 'calls'))).toBe(false);
  });

  it('refuses a Codex id that is the end of an active and an archived session\'s ids, and runs no judge', async () => {
    const config = await fixture();
    const ids = ['019a0000-0000-7000-8000-0000000000bb', '019b0000-0000-7000-9000-0000000000bb'];
    for (const [index, id] of ids.entries()) {
      const dir = path.join(mocks.home, '.codex', index === 0 ? path.join('sessions', '2026', '10', '20') : 'archived_sessions');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `rollout-2026-10-20T12-00-0${index}-${id}.jsonl`), [
        { type: 'session_meta', payload: { id, timestamp: '2026-10-20T10:00:00.000Z', cwd: path.join(root, `app-${index}`) } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Work on app ${index}` }] } },
      ].map(line).join(''));
    }
    fakeClaude('good');

    expect(await tryScorer(config, { session: '0000000000bb', source: 'codex', scorers: [quality()] })).toEqual({
      error: { code: 'session_ambiguous', message: `--session 0000000000bb names more than one codex session: ${ids.join(', ')}. Pass the whole id of one.` },
    });
    expect(fs.existsSync(path.join(root, 'calls'))).toBe(false);
  });

  it('prints the first prompt of a Codex session after the AGENTS.md block Codex injects', async () => {
    const config = await fixture();
    const id = '019a0000-0000-7000-8000-0000000000aa';
    const cwd = path.join(root, 'app');
    const day = path.join(mocks.home, '.codex', 'sessions', '2026', '10', '20');
    fs.mkdirSync(day, { recursive: true });
    const message = (role: string, text: string): unknown => ({ timestamp: '2026-10-20T10:00:02.000Z', type: 'response_item',
      payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] } });
    fs.writeFileSync(path.join(day, `rollout-2026-10-20T12-00-00-${id}.jsonl`), [
      { timestamp: '2026-10-20T10:00:00.000Z', type: 'session_meta', payload: { id, timestamp: '2026-10-20T10:00:00.000Z', cwd, originator: 'codex_cli_rs', cli_version: '0.163.0' } },
      message('user', `# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>\n# Team rules\n\nAlways write tests.\n</INSTRUCTIONS>`),
      message('user', `<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>`),
      message('user', 'Add retries to the client'),
      message('assistant', 'Added the retries.'),
    ].map(line).join(''));
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    fakeClaude('good');

    data(await tryScorer(config, { session: id, source: 'codex', scorers: [quality()] }));
    expect(printed.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('First prompt: Add retries to the client');
  });

  it('prints the session before judging, then the verdict of the file', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    const output = (): string => printed.mock.calls.map((call) => call.join(' ')).join('\n');

    fakeClaude('good');
    data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [quality()] }));
    expect(output()).toContain(`in ${path.join(root, 'app')}`);
    expect(output()).toContain('First prompt: Add retries to the client');
    expect(output()).toContain('quality from draft/quality.md: good (score 1, passed). Not stored: a scorer file\'s label is only tried.');

    printed.mockClear();
    fakeClaude('bad');
    data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [quality()] }));
    expect(output()).toContain('quality from draft/quality.md: bad (score 0, did not pass)');
  });

  it('keeps the start and the end of a session longer than 200,000 characters and tells the judge how much was cut', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), `Start here. ${'Add the retry loop to the client. '.repeat(9_000)}`);
    fakeClaude('good');

    data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [quality()] }));
    const judged = fs.readFileSync(path.join(root, 'judged-transcript.md'), 'utf8');
    expect(judged).toContain('Start here.');
    expect(judged).toContain('Added the retries.');
    expect(Number(/\[\.\.\. (\d+) characters of evidence were cut here/.exec(judged)?.[1])).toBeGreaterThan(100_000);
  });

  it('gives the judge a transcript file cut to 200,000 characters, with one note of how much was cut', async () => {
    const config = await fixture();
    const prose = 'Add the retry loop to the client. '.repeat(6_000);
    plantClaudeSession(path.join(root, 'app'), `Start here. ${prose}MIDDLE_OF_THE_SESSION ${prose}`);
    fakeClaude('good');

    data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [quality()] }));
    const transcript = fs.readFileSync(path.join(root, 'judged-transcript.md'), 'utf8');
    expect(transcript.length).toBeLessThanOrEqual(200_000);
    expect(transcript).not.toContain('MIDDLE_OF_THE_SESSION');
    expect(transcript.match(/characters of evidence were cut here/g)).toHaveLength(1);
  });

  it('prints no label when the answer names no label of the scorer, and stores none', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    fakeClaude('excellent');

    const answer = await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [quality()] });
    expect(answer).toEqual({ error: { code: 'judge_answer_invalid', message: expect.stringContaining('"excellent" is not a label of scorer quality') } });
    expect(fs.existsSync(labelsFile())).toBe(false);
  });

  it('names the scorer file it cannot read, and runs no judge', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    fakeClaude('good');

    expect(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: ['./draft/nope.md'] })).toEqual({
      error: { code: 'scorer_not_found', message: 'draft/nope.md: could not be read' },
    });
    expect(fs.existsSync(path.join(root, 'judged.md'))).toBe(false);
  });

  it('shares one judge call between scorer files with --batch, and one control call', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    const files: [string, string] = [quality(), draft(SCORER, 'tests').file];
    fakeClaude({ quality: { label: 'good', reasoning: 'r1' }, tests: { label: 'bad', reasoning: 'r2' } });

    expect(data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: files, batch: true }))).toMatchObject({
      labels: [{ scorer: 'quality', label: 'good' }, { scorer: 'tests', label: 'bad' }],
    });
    expect(fs.readFileSync(path.join(root, 'calls'), 'utf8')).toBe('xx');
  });

  it('shares one judge call between scorer files when the team\'s scorers/scoring.yaml batches them', async () => {
    const config = await fixture();
    fs.writeFileSync(path.join(config.repo.localPath, 'scorers', 'scoring.yaml'), 'batch: true\n');
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    const files: [string, string] = [quality(), draft(SCORER, 'tests').file];
    fakeClaude({ quality: { label: 'good', reasoning: 'r1' }, tests: { label: 'bad', reasoning: 'r2' } });

    expect(data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: files }))).toMatchObject({
      labels: [{ scorer: 'quality', label: 'good' }, { scorer: 'tests', label: 'bad' }],
    });
    expect(fs.readFileSync(path.join(root, 'calls'), 'utf8')).toBe('xx');
  });

  it('prints the member\'s own first prompt when it names a file and loads a skill', async () => {
    const config = await fixture();
    const cwd = path.join(root, 'app');
    const project = path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd));
    fs.mkdirSync(project, { recursive: true });
    const asked = 'Call the Skill tool with skill "review-notes", then read .claude/skills/deploy-notes/SKILL.md.';
    fs.writeFileSync(path.join(project, `${SESSION}.jsonl`), [
      { type: 'user', uuid: 'u1', parentUuid: null, cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: asked } },
      { type: 'assistant', uuid: 'u2', parentUuid: 'u1', cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:01.000Z',
        message: { role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Skill', input: { skill: 'review-notes' } }] } },
      { type: 'user', uuid: 'u3', parentUuid: 'u2', cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:02.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Launching skill: review-notes' }] } },
      { type: 'user', uuid: 'u4', parentUuid: 'u3', isMeta: true, cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:03.000Z',
        message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: ${cwd}/.claude/skills/review-notes\n\nHow this team reviews a change.\n` }] } },
      { type: 'assistant', uuid: 'u5', parentUuid: 'u4', cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:04.000Z',
        message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'done' }] } },
    ].map(line).join(''));
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    fakeClaude('good');

    data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [quality()] }));
    expect(printed.mock.calls.map((call) => call.join(' ')).join('\n')).toContain(`First prompt: ${asked}`);
  });

  it('prints the /name args the member typed as the first prompt, not the skill body it loads', async () => {
    const config = await fixture();
    const cwd = path.join(root, 'app');
    const project = path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd));
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, `${SESSION}.jsonl`), [
      { type: 'user', uuid: 'u1', parentUuid: null, cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:00.000Z',
        message: { role: 'user', content: '<command-message>review-notes</command-message>\n<command-name>/review-notes</command-name>\n<command-args>check the README</command-args>' } },
      { type: 'user', uuid: 'u2', parentUuid: 'u1', isMeta: true, cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: ${cwd}/.claude/skills/review-notes\n\nHow this team reviews a change.\n\n\nARGUMENTS: check the README` }] } },
      { type: 'assistant', uuid: 'u3', parentUuid: 'u2', cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:02.000Z',
        message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'REVIEWED' }] } },
    ].map(line).join(''));
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    fakeClaude('good');

    data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [quality()] }));
    expect(printed.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('First prompt: /review-notes check the README');
  });

  it('prints the whole /name args the member typed when the args hold a less-than sign', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>check whether attempts < 3 in src/client.ts</command-args>');
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    fakeClaude('good');

    data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [quality()] }));
    expect(printed.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('First prompt: /review check whether attempts < 3 in src/client.ts');
  });

  it('prints the session\'s redacted first prompt', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries with key sk-ABCDEFGH1234567890abcdefghij');
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    fakeClaude('good');

    data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [quality()] }));
    const output = printed.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toMatch(/First prompt: Add retries with key /);
    expect(output).not.toContain('sk-ABCDEFGH1234567890abcdefghij');
  });

  it('masks the value of a secret the team declares, whatever its name, in the evidence and the first prompt', async () => {
    const dsn = 'mysql-prod-7Hq2xVb9Lk';
    const config = await fixture();
    fs.mkdirSync(path.join(config.repo.localPath, 'env'), { recursive: true });
    fs.writeFileSync(path.join(config.repo.localPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: WAREHOUSE_DSN\n');
    vi.stubEnv('WAREHOUSE_DSN', dsn);
    plantClaudeSession(path.join(root, 'app'), `Add retries against ${dsn}`);
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    fakeClaude('good');

    data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [quality()] }));

    expect(fs.readFileSync(path.join(root, 'judged-transcript.md'), 'utf8')).toContain('Add retries against');
    for (const text of [fs.readFileSync(path.join(root, 'judged.md'), 'utf8'), fs.readFileSync(path.join(root, 'judged-transcript.md'), 'utf8'), printed.mock.calls.flat().join('\n')]) {
      expect(text).not.toContain(dsn);
    }
  });

  it('masks a secret the team declares in the scorer\'s prompt as well', async () => {
    const dsn = 'mysql-prod-7Hq2xVb9Lk';
    const config = await fixture();
    fs.mkdirSync(path.join(config.repo.localPath, 'env'), { recursive: true });
    fs.writeFileSync(path.join(config.repo.localPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: WAREHOUSE_DSN\n');
    vi.stubEnv('WAREHOUSE_DSN', dsn);
    plantClaudeSession(path.join(root, 'app'), 'Add retries');
    fakeClaude('good');

    data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [quality(SCORER.replace('Judge the session.', `Judge the session. Never print ${dsn}.`))] }));

    const judged = fs.readFileSync(path.join(root, 'judged.md'), 'utf8');
    expect(judged).toContain('Judge the session. Never print');
    expect(judged).not.toContain(dsn);
  });

  it('masks both the environment value of a secret and the different value the team gives it, in the scorer\'s prompt, the evidence and the first prompt', async () => {
    const personal = 'personal-token-value-1362';
    const team = 'team-token-value-1362';
    const config = await fixture();
    fs.mkdirSync(path.join(config.repo.localPath, 'env'), { recursive: true });
    fs.writeFileSync(path.join(config.repo.localPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: DEPLOY_HOOK\n');
    await writeSecretStore(getTeamSecretsPath(config), { DEPLOY_HOOK: { value: team } });
    vi.stubEnv('DEPLOY_HOOK', personal);
    plantClaudeSession(path.join(root, 'app'), `Deploy with ${personal}`);
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    fakeClaude('good');

    data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [quality(SCORER.replace('Judge the session.', `Judge the session. Never print ${personal} or ${team}.`))] }));

    expect(fs.readFileSync(path.join(root, 'judged.md'), 'utf8')).toContain('Judge the session. Never print');
    for (const text of [fs.readFileSync(path.join(root, 'judged.md'), 'utf8'), fs.readFileSync(path.join(root, 'judged-transcript.md'), 'utf8'), printed.mock.calls.flat().join('\n')]) {
      expect(text).not.toContain(personal);
      expect(text).not.toContain(team);
    }
  });

  it('lists the labels the scope the session ran in keeps, also when it is tried from another one', async () => {
    const { userHome, elsewhere } = await scopedElsewhere('self');
    await LabelStore.append({ repo: elsewhere.repo, username: 'tester', scope: 'user', additionalRoles: [] }, [{ label: {
      scorer: 'quality', rubric: { sourceHash: 'h1' }, label: 'bad', score: 0, passed: false, source: 'session',
      subject: { platform: 'claude-code', sessionId: SESSION }, judge: { kind: 'human' }, scoredAt: '2026-10-20T12:00:00.000Z',
    }, reasoning: 'Did not.' }]);

    expect(data(await tryScorer(elsewhere, { session: SESSION, source: 'claude-code', scorers: [quality()] }))).toMatchObject({
      stored: [{ rubric: { sourceHash: 'h1' }, label: 'bad', judge: { kind: 'human' } }],
    });
    expect(parseScoreLabels(fs.readFileSync(path.join(userHome, 'scores', 'labels.jsonl'), 'utf8'))).toHaveLength(1);
    expect(fs.existsSync(path.join(root, 'elsewhere-data', 'scores'))).toBe(false);
  });

  it('asks the judge for the isolation a namespace of the workspace\'s children sets', async () => {
    const knowledge = path.join(root, 'knowledge');
    const files = {
      'manifest/roles.yaml': 'version: 1\nroles:\n  - id: dev\n    resources: { knowledge: [], skills: [] }\n',
      'manifest/projects.yaml': 'version: 1\nprojects:\n'
        + '  - id: billing\n    name: Billing\n    resources: { scorers: [billing] }\n'
        + '  - id: checkout\n    name: Checkout\n    resources: { scorers: [checkout] }\n',
      'scorers/quality.md': SCORER,
      'scorers/checkout/scoring.yaml': 'isolation: verified\n',
    };
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(knowledge, file)), { recursive: true });
      fs.writeFileSync(path.join(knowledge, file), text);
    }
    const remote = 'https://git.example.com/team/team.git';
    const member = (projects: string[]) => `repo:\n  localPath: ${knowledge}\n  remote: ${remote}\nusername: tester\nscope: project\nadditionalRoles: []\nprojects: [${projects.join(', ')}]\n`;
    const repoAt = (dir: string, projects: string[]): string => {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: dir });
      const dataHome = projectDataHome(fs.realpathSync(dir));
      fs.mkdirSync(dataHome, { recursive: true });
      fs.writeFileSync(path.join(dataHome, 'config.yaml'), member(projects));
      return dataHome;
    };
    const ws = path.join(root, 'ws');
    const workspace: LocalConfig = {
      repo: { localPath: knowledge, remote }, username: 'tester', scope: 'project', additionalRoles: [], projects: ['billing'],
      projectRoot: ws, dataHome: repoAt(ws, ['billing']),
    };
    repoAt(path.join(ws, 'svc'), ['checkout']);
    await syncScorerDefinitions(workspace);
    plantClaudeSession(ws, 'Add retries to the client');
    fakeClaude('good', '2.0.0 (Claude Code)');

    expect(await tryScorer(workspace, { session: SESSION, source: 'claude-code', scorers: [quality()] })).toEqual({
      error: { code: 'confined_pending', message: 'step "session.score[0].judge" runs confined at verified, which no offer in this driver\'s can.confined reaches' },
    });
  });

  it('holds the judge of a scorer file that asks for a verified judge when no tool here judges at verified', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    fakeClaude('good', '2.0.0 (Claude Code)');

    expect(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [quality(SCORER.replace('samplingRate: 0', 'samplingRate: 0\nisolation: verified'))] })).toEqual({ error: {
      code: 'confined_pending',
      message: 'step "session.score[0].judge" runs confined at verified, which no offer in this driver\'s can.confined reaches',
    } });
  });

  describe('a scorer file', () => {
    const WARNING = 'This rubric passes a session where the agent did nothing, so it may not judge the work.';

    /** A Claude judge that gives `good` only when the evidence holds `work`, else `otherwise`. */
    function fakeClaudeJudgingWork(work: string, otherwise = 'bad'): void {
      fakeClaude('good');
      const bin = path.join(root, 'bin', 'claude');
      const fixed = fs.readFileSync(bin, 'utf8');
      const judging = fixed.replace('structured_output: {"answer":{"label":"good"',
        `structured_output: { answer: { label: fs.readFileSync(require('node:path').join('transcripts', 'session.md'), 'utf8').includes(${JSON.stringify(work)}) ? 'good' : ${JSON.stringify(otherwise)}`);
      if (judging === fixed) throw new Error('fakeClaude no longer writes the answer this helper rewrites');
      fs.writeFileSync(bin, judging);
    }

    it('prints the file\'s label with its reasoning, stores nothing, and lists the labels stored for its scorer', async () => {
      const config = await fixture();
      plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
      const cached = { scorer: 'quality', rubric: { sourceHash: 'h1' }, label: 'bad', score: 0, passed: false, source: 'session' as const,
        subject: { platform: 'claude-code', sessionId: SESSION }, judge: { kind: 'model' as const, tool: 'claude', isolation: 'verified' as const, access: 'read' as const }, scoredAt: '2026-10-20T12:00:00.000Z' };
      await LabelStore.append(config, [{ label: cached, reasoning: 'Did not.' }]);
      const { file, store } = draft();
      const before = store();
      fakeClaudeJudgingWork('Added the retries.');

      const tried = data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [file] }));
      expect(tried).toEqual({
        label: {
          scorer: 'quality', file: 'draft/quality.md', subject: { platform: 'claude-code', sessionId: SESSION },
          rubric: { sourceHash: expect.not.stringMatching(cached.rubric.sourceHash) }, label: 'good', score: 1, passed: true, reasoning: 'the reasoning', stored: false,
        },
        stored: [{ rubric: cached.rubric, label: 'bad', score: 0, passed: false, judge: { kind: 'model', tool: 'claude' } }],
        control: { label: 'bad', score: 0, passed: false },
      });
      expect(store()).toEqual(before);
    });

    it('judges the control on the session\'s first prompt alone, and warns when the rubric passes it', async () => {
      const config = await fixture();
      plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
      plantSubagentEdit(path.join(root, 'app'));
      const { file, store } = draft();
      fakeClaude('good');

      expect(data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [file] }))).toMatchObject({
        label: { passed: true, stored: false }, stored: [], control: { label: 'good', score: 1, passed: true, warning: WARNING },
      });
      expect(fs.readFileSync(path.join(root, 'calls'), 'utf8')).toBe('xx');
      const control = fs.readFileSync(path.join(root, 'transcript-2.md'), 'utf8');
      expect(control).toContain('Add retries to the client');
      expect(control).not.toContain('Added the retries.');
      expect(control).not.toContain('retryWithBackoff');
      expect(store()).toEqual(['', '', '']);
    });

    it('fails with the message teamai pull gives for an invalid file, and runs no judge', async () => {
      const config = await fixture();
      plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
      const { file } = draft(SCORER.replace('passingScore: 0.5', 'passingScore: 2'));
      fakeClaude('good');

      expect(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [file] })).toEqual({
        error: { code: 'scorer_invalid', message: 'draft/quality.md: passingScore must have at least one label at or above it and one below it' },
      });
      expect(fs.existsSync(path.join(root, 'calls'))).toBe(false);
    });

    it('still prints the file\'s label when the control cannot be judged, and says why in control', async () => {
      const config = await fixture();
      plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
      const { file } = draft();
      fakeClaudeJudgingWork('Added the retries.', 'excellent');

      expect(data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [file] }))).toMatchObject({
        label: { label: 'good', stored: false },
        control: { error: { code: 'judge_answer_invalid', message: expect.stringContaining('"excellent" is not a label of scorer quality') } },
      });
    });

    it('refuses a file that does not end in .md, as teamai pull does, and runs no judge', async () => {
      const config = await fixture();
      plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
      draft();
      fs.copyFileSync(path.join(root, 'draft', 'quality.md'), path.join(root, 'draft', 'quality'));
      fakeClaude('good');

      expect(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: ['./draft/quality'] })).toEqual({
        error: { code: 'scorer_invalid', message: expect.stringMatching(/^draft\/quality: not a scorer file;/) },
      });
      expect(fs.existsSync(path.join(root, 'calls'))).toBe(false);
    });

    it('refuses a README.md, which teamai pull skips', async () => {
      const config = await fixture();
      plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
      draft(DRAFT, 'README');
      fakeClaude('good');

      expect(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: ['./draft/README.md'] })).toEqual({
        error: { code: 'scorer_invalid', message: expect.stringMatching(/^draft\/README\.md: not a scorer file;/) },
      });
      expect(fs.existsSync(path.join(root, 'calls'))).toBe(false);
    });

    it('tries a file while another teamai process holds the label store', async () => {
      const config = await fixture();
      plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
      const { file } = draft();
      fakeClaude('good');

      const held = await whileLabelsLocked(config, () => tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [file] }));
      expect(held).toMatchObject({ data: { label: { label: 'good', stored: false }, control: { passed: true } } });
    });

    it('shares one control call between the files of a batch', async () => {
      const config = await fixture();
      plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
      const files: [string, string] = [draft().file, draft(DRAFT, 'tests').file];
      fakeClaude({ quality: { label: 'good', reasoning: 'r1' }, tests: { label: 'bad', reasoning: 'r2' } });

      expect(data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: files, batch: true }))).toMatchObject({
        labels: [{ scorer: 'quality', stored: false }, { scorer: 'tests', stored: false }],
        stored: { quality: [], tests: [] },
        control: { quality: { label: 'good', passed: true, warning: WARNING }, tests: { label: 'bad', passed: false } },
      });
      expect(fs.readFileSync(path.join(root, 'calls'), 'utf8')).toBe('xx');
    });

    it('refuses two files of the same scorer in one command', async () => {
      const config = await fixture();
      plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
      const files: [string, string] = [draft().file, draft(DRAFT, 'quality', 'other').file];
      fakeClaude('good');

      expect(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: files })).toEqual({ error: {
        code: 'invalid_arguments', message: '--scorer draft/quality.md and --scorer other/quality.md are both scorer quality. Judge them in separate commands.',
      } });
      expect(fs.existsSync(path.join(root, 'calls'))).toBe(false);
    });
  });

  describe('the team skills a session used', () => {
    /** A capture of the session recording the team skills its checkout delivered, as `deliveredTeamSkills` does. */
    function captureTeamSkills(platform: string, sessionId: string, teamSkills: Record<string, string[]>, { captureId = '0b6f2a52-5d7e-4c7e-9a43-6a3c1d0e2f10', capturedAt = '2026-10-20T10:00:00.000Z' } = {}): void {
      const dir = path.join(root, 'data', 'sessions', 'captures', platform, sessionId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${captureId}.json`), JSON.stringify({
        captureId, platform, sessionId, capturedAt, agent: { v: 1, tool: { name: 'claude' }, teamai: '1.0.0', driver: 'session' }, teamSkills,
      }));
    }

    /** `team` in the team repo, `installed` in the checkout, and a capture recording the team ones installed as delivered. */
    function plantSkills(cwd: string, config: LocalConfig, team: string[], installed: string[]): void {
      for (const name of team) writeSkill(path.join(config.repo.localPath, 'skills', name));
      for (const name of installed) writeSkill(path.join(cwd, '.claude', 'skills', name));
      captureTeamSkills('claude-code', SESSION, Object.fromEntries(team.filter((name) => installed.includes(name)).map((name) => [name, [path.join(cwd, '.claude', 'skills', name, 'SKILL.md')]])));
    }

    function writeSkill(dir: string): void {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${path.basename(dir)}\ndescription: d\n---\nbody\n`);
    }

    /** What Codex records after a code-mode script that passed `text` the result of a command printing `printed`. */
    function codeModeOutput(callId: string, printed: string): Record<string, unknown> {
      return {
        type: 'custom_tool_call_output',
        call_id: callId,
        output: [
          { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
          { type: 'input_text', text: JSON.stringify({ exit_code: 0, output: printed }) },
        ],
      };
    }

    function appendCalls(file: string, cwd: string, calls: Array<{ name: string; input: Record<string, unknown> }>, sidechain = false): void {
      fs.appendFileSync(file, calls.map((call, index) => line({
        type: 'assistant', uuid: `c${index}`, parentUuid: 'u2', cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:02.000Z', ...(sidechain ? { isSidechain: true } : {}),
        message: { role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id: `toolu_${index}`, name: call.name, input: call.input }] },
      })).join(''));
    }

    /** The team skills the label a scorer file gets on the session names: none when it names none. */
    async function usedOn(scored: WorkflowEnvelope): Promise<unknown> {
      return z.object({ label: z.object({ used: z.unknown().optional() }) }).parse(data(scored)).label.used ?? { skills: [] };
    }

    async function usedBy(config: LocalConfig): Promise<unknown> {
      fakeClaude('good');
      return usedOn(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [quality()] }));
    }

    it('names a team skill loaded through the skill tool and one whose SKILL.md was read, and no skill outside the team repo', async () => {
      const config = await fixture();
      const cwd = path.join(root, 'app');
      plantClaudeSession(cwd, 'Review the change');
      plantSkills(cwd, config, ['review', 'deploy'], ['review', 'deploy', 'mine']);
      appendCalls(path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd), `${SESSION}.jsonl`), cwd, [
        { name: 'Skill', input: { skill: 'review' } },
        { name: 'Read', input: { file_path: path.join(cwd, '.claude', 'skills', 'deploy', 'SKILL.md') } },
        { name: 'Skill', input: { skill: 'mine' } },
      ]);

      expect(await usedBy(config)).toEqual({ skills: ['deploy', 'review'] });
    });

    it('names the team skills a session used in the label it prints, and leaves them out when it used none', async () => {
      const config = await fixture();
      const cwd = path.join(root, 'app');
      plantClaudeSession(cwd, 'Review the change');
      plantSkills(cwd, config, ['review'], ['review']);
      fakeClaude('good');
      expect(data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [quality()] }))).not.toHaveProperty('label.used');

      appendCalls(path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd), `${SESSION}.jsonl`), cwd, [{ name: 'Skill', input: { skill: 'review' } }]);
      expect(data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [quality()] }))).toMatchObject({ label: { used: { skills: ['review'] } } });
    });

    it('still names a team skill the session loaded after a later pull removed it from the team repo and the checkout', async () => {
      const config = await fixture();
      const cwd = path.join(root, 'app');
      plantClaudeSession(cwd, 'Review the change');
      plantSkills(cwd, config, ['review'], ['review']);
      appendCalls(path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd), `${SESSION}.jsonl`), cwd, [{ name: 'Skill', input: { skill: 'review' } }]);
      fs.rmSync(path.join(config.repo.localPath, 'skills', 'review'), { recursive: true });
      fs.rmSync(path.join(cwd, '.claude', 'skills', 'review'), { recursive: true });

      expect(await usedBy(config)).toEqual({ skills: ['review'] });
    });

    it('credits a load by the capture in effect when it happened, so none after a resume whose capture lost the team skill', async () => {
      const config = await fixture();
      const cwd = path.join(root, 'app');
      const transcript = path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd), `${SESSION}.jsonl`);
      const loadAt = (timestamp: string): void => {
        plantClaudeSession(cwd, 'Review the change');
        fs.appendFileSync(transcript, line({
          type: 'assistant', uuid: 'c0', parentUuid: 'u2', cwd, sessionId: SESSION, timestamp,
          message: { role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id: 'toolu_0', name: 'Skill', input: { skill: 'review' } }] },
        }));
      };
      plantSkills(cwd, config, ['review'], ['review']);
      captureTeamSkills('claude-code', SESSION, {}, { captureId: '0b6f2a52-5d7e-4c7e-9a43-6a3c1d0e2f11', capturedAt: '2026-10-20T10:00:05.000Z' });
      fakeClaude('good');

      loadAt('2026-10-20T10:00:06.000Z');
      expect(data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [quality()] }))).not.toHaveProperty('label.used');
      loadAt('2026-10-20T10:00:02.000Z');
      expect(data(await tryScorer(config, { session: SESSION, source: 'claude-code', scorers: [quality()] }))).toMatchObject({ label: { used: { skills: ['review'] } } });
    });

    it('names no skill its captures did not record as delivered, though the team repo has one of its name', async () => {
      const config = await fixture();
      const cwd = path.join(root, 'app');
      plantClaudeSession(cwd, 'Review the change');
      plantSkills(cwd, config, ['review'], ['review']);
      captureTeamSkills('claude-code', SESSION, {});
      appendCalls(path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd), `${SESSION}.jsonl`), cwd, [{ name: 'Skill', input: { skill: 'review' } }]);

      expect(await usedBy(config)).toEqual({ skills: [] });
      fs.rmSync(path.join(root, 'data', 'sessions'), { recursive: true });
      expect(await usedBy(config)).toEqual({ skills: [] });
    });

    it('names a team skill read from its SKILL.md only when the read was the copy teamai delivered', async () => {
      const config = await fixture();
      const cwd = path.join(root, 'app');
      plantClaudeSession(cwd, 'Review the change');
      plantSkills(cwd, config, ['review'], ['review']);
      writeSkill(path.join(mocks.home, '.claude', 'skills', 'review'));
      appendCalls(path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd), `${SESSION}.jsonl`), cwd, [
        { name: 'Read', input: { file_path: path.join(mocks.home, '.claude', 'skills', 'review', 'SKILL.md') } },
      ]);

      expect(await usedBy(config)).toEqual({ skills: [] });
    });

    it('names a team skill the member typed as /name', async () => {
      const config = await fixture();
      const cwd = path.join(root, 'app');
      plantClaudeSession(cwd, '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>the retry change</command-args>');
      plantSkills(cwd, config, ['review'], ['review']);

      expect(await usedBy(config)).toEqual({ skills: ['review'] });
    });

    async function usedByCodex(config: LocalConfig, cwd: string, items: unknown[]): Promise<unknown> {
      const id = '019a0000-0000-7000-8000-0000000000bb';
      const day = path.join(mocks.home, '.codex', 'sessions', '2026', '10', '20');
      fs.mkdirSync(day, { recursive: true });
      fs.writeFileSync(path.join(day, `rollout-2026-10-20T12-00-00-${id}.jsonl`), [
        { type: 'session_meta', payload: { id, timestamp: '2026-10-20T10:00:00.000Z', cwd, originator: 'codex_cli_rs', cli_version: '0.163.0' } },
        ...items.map((payload) => ({ type: 'response_item', payload })),
      ].map((record) => line({ timestamp: '2026-10-20T10:00:01.000Z', ...record })).join(''));
      fakeClaude('good');
      return usedOn(await tryScorer(config, { session: id, source: 'codex', scorers: [quality()] }));
    }

    it('names a team skill a Codex prompt mentions as $name', async () => {
      const config = await fixture();
      const cwd = path.join(root, 'app');
      plantSkills(cwd, config, ['review'], []);
      writeSkill(path.join(cwd, '.agents', 'skills', 'review'));
      captureTeamSkills('codex', '019a0000-0000-7000-8000-0000000000bb', { review: [path.join(cwd, '.agents', 'skills', 'review', 'SKILL.md')] });

      expect(await usedByCodex(config, cwd, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check the retries with $review' }] }]))
        .toEqual({ skills: ['review'] });
    });

    it('names a team skill whose SKILL.md a Codex command read', async () => {
      const config = await fixture();
      const cwd = path.join(root, 'app');
      plantSkills(cwd, config, ['review'], []);
      writeSkill(path.join(cwd, '.agents', 'skills', 'review'));
      captureTeamSkills('codex', '019a0000-0000-7000-8000-0000000000bb', { review: [path.join(cwd, '.agents', 'skills', 'review', 'SKILL.md')] });
      const cmd = `sed -n '1,240p' ${path.join(cwd, '.agents', 'skills', 'review', 'SKILL.md')}`;

      expect(await usedByCodex(config, cwd, [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check the retries' }] },
        { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: JSON.stringify({ cmd, yield_time_ms: 1000 }) },
      ])).toEqual({ skills: ['review'] });
    });

    it('names a team skill whose SKILL.md one line of a multi-line Codex command read', async () => {
      const config = await fixture();
      const cwd = path.join(root, 'app');
      plantSkills(cwd, config, ['review'], []);
      writeSkill(path.join(cwd, '.agents', 'skills', 'review'));
      captureTeamSkills('codex', '019a0000-0000-7000-8000-0000000000bb', { review: [path.join(cwd, '.agents', 'skills', 'review', 'SKILL.md')] });
      const cmd = [
        `sed -n '1,260p' ${path.join(cwd, '.agents', 'skills', 'review', 'SKILL.md')}`,
        `rg -n -i "review|gate" ${path.join(mocks.home, '.codex', 'memories', 'MEMORY.md')}`,
        "sed -n '1,260p' docs/agents/issue-tracker.md",
        "find .scratch -maxdepth 3 -type f -name '*.md' -print | sort",
      ].join('\n');

      expect(await usedByCodex(config, cwd, [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check the retries' }] },
        { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: JSON.stringify({ cmd, workdir: cwd, yield_time_ms: 10000, max_output_tokens: 30000 }) },
        { type: 'function_call_output', call_id: 'call_1', output: 'Chunk ID: 1a2b3c\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 12\nOutput:\n---\nname: review\ndescription: d\n---\nbody\n.scratch/notes.md\n' },
      ])).toEqual({ skills: ['review'] });
    });

    it.each([
      ['the delivered copy', ['.agents', 'skills', 'review', 'SKILL.md'], ['review']],
      ['the member\'s own copy', ['.codex', 'skills', 'review', 'SKILL.md'], []],
    ])('names the team skills whose SKILL.md a Codex code-mode command read: %s', async (_, file, skills) => {
      const config = await fixture();
      const cwd = path.join(root, 'app');
      plantSkills(cwd, config, ['review'], []);
      writeSkill(path.join(cwd, '.agents', 'skills', 'review'));
      captureTeamSkills('codex', '019a0000-0000-7000-8000-0000000000bb', { review: [path.join(cwd, '.agents', 'skills', 'review', 'SKILL.md')] });
      const read = path.join(file[0] === '.agents' ? cwd : mocks.home, ...file);

      expect(await usedByCodex(config, cwd, [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check the retries' }] },
        { type: 'custom_tool_call', status: 'completed', call_id: 'call_1', name: 'exec', input: `text(await tools.exec_command({cmd:${JSON.stringify(`cat ${read}`)},max_output_tokens:10000}));\n` },
        codeModeOutput('call_1', '---\nname: review\ndescription: d\n---\nbody\n'),
      ])).toEqual({ skills });
    });

    it.each([
      ['no team skill a Codex command skipped after &&', 'false && cat FILE; true', '', []],
      ['a team skill a Codex command read after && and printed', 'test -f FILE && cat FILE; echo done', '---\nname: review\ndescription: d\n---\nbody\ndone\n', ['review']],
    ])('names %s', async (_, command, printed, skills) => {
      const config = await fixture();
      const cwd = path.join(root, 'app');
      plantSkills(cwd, config, ['review'], []);
      writeSkill(path.join(cwd, '.agents', 'skills', 'review'));
      captureTeamSkills('codex', '019a0000-0000-7000-8000-0000000000bb', { review: [path.join(cwd, '.agents', 'skills', 'review', 'SKILL.md')] });
      const cmd = command.replaceAll('FILE', path.join(cwd, '.agents', 'skills', 'review', 'SKILL.md'));

      expect(await usedByCodex(config, cwd, [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check the retries' }] },
        { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: JSON.stringify({ cmd, workdir: cwd }) },
        { type: 'function_call_output', call_id: 'call_1', output: `Chunk ID: 1a2b3c\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 9\nOutput:\n${printed}` },
      ])).toEqual({ skills });
    });

    it.each([
      ['a compound command', (file: string) => `sed -n '1,260p' ${file}\nrg -n retries README.md`, '---\nname: review\ndescription: d\n---\nbody\n'],
      ['cat -n', (file: string) => `cat -n ${file}`, '     1\t---\n     2\tname: review\n     3\tdescription: d\n     4\t---\n'],
    ])('names the team skill whose SKILL.md %s in a Codex code-mode script read, as its JSON-printed output shows', async (_, command, printed) => {
      const config = await fixture();
      const cwd = path.join(root, 'app');
      plantSkills(cwd, config, ['review'], []);
      writeSkill(path.join(cwd, '.agents', 'skills', 'review'));
      captureTeamSkills('codex', '019a0000-0000-7000-8000-0000000000bb', { review: [path.join(cwd, '.agents', 'skills', 'review', 'SKILL.md')] });
      const cmd = command(path.join(cwd, '.agents', 'skills', 'review', 'SKILL.md'));

      expect(await usedByCodex(config, cwd, [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check the retries' }] },
        { type: 'custom_tool_call', status: 'completed', call_id: 'call_1', name: 'exec', input: `text(await tools.exec_command({cmd:${JSON.stringify(cmd)}}));\n` },
        codeModeOutput('call_1', printed),
      ])).toEqual({ skills: ['review'] });
    });

    it('names the team skill a Codex code-mode script read, though a later command of the script failed on the same path elsewhere', async () => {
      const config = await fixture();
      const cwd = path.join(root, 'app');
      plantSkills(cwd, config, ['review'], []);
      writeSkill(path.join(cwd, '.agents', 'skills', 'review'));
      captureTeamSkills('codex', '019a0000-0000-7000-8000-0000000000bb', { review: [path.join(cwd, '.agents', 'skills', 'review', 'SKILL.md')] });
      const read = (workdir: string) => `text((await tools.exec_command({cmd:"cat .agents/skills/review/SKILL.md",workdir:${JSON.stringify(workdir)}})).output);\n`;

      expect(await usedByCodex(config, cwd, [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check the retries' }] },
        { type: 'custom_tool_call', status: 'completed', call_id: 'call_1', name: 'exec', input: read(cwd) + read(path.join(cwd, 'src')) },
        { type: 'custom_tool_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n---\nname: review\ndescription: d\n---\nbody\n\ncat: .agents/skills/review/SKILL.md: No such file or directory\n' }] },
      ])).toEqual({ skills: ['review'] });
    });

    it('names no team skill a Codex code-mode script names in a call its output shows never ran', async () => {
      const config = await fixture();
      const cwd = path.join(root, 'app');
      plantSkills(cwd, config, ['review'], []);
      writeSkill(path.join(cwd, '.agents', 'skills', 'review'));
      captureTeamSkills('codex', '019a0000-0000-7000-8000-0000000000bb', { review: [path.join(cwd, '.agents', 'skills', 'review', 'SKILL.md')] });
      const cmd = `cat ${path.join(cwd, '.agents', 'skills', 'review', 'SKILL.md')}`;

      expect(await usedByCodex(config, cwd, [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check the retries' }] },
        { type: 'custom_tool_call', status: 'completed', call_id: 'call_1', name: 'exec', input: `if (false) { text(await tools.exec_command({cmd:${JSON.stringify(cmd)}})); }\ntext("done");\n` },
        codeModeOutput('call_1', 'done'),
      ])).toEqual({ skills: [] });
    });

    it.each([
      ['a command', (cmd: string, workdir: string) => ({ type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: JSON.stringify({ cmd, workdir }) })],
      ['a code-mode command', (cmd: string, workdir: string) => ({ type: 'custom_tool_call', status: 'completed', call_id: 'call_1', name: 'exec', input: `text(await tools.exec_command({cmd:${JSON.stringify(cmd)},workdir:${JSON.stringify(workdir)}}));\n` })],
    ])('reads the SKILL.md %s names relative to its Codex workdir, not the session\'s', async (_, call) => {
      const config = await fixture();
      const cwd = path.join(root, 'app');
      const other = path.join(root, 'other');
      plantSkills(cwd, config, ['review'], []);
      writeSkill(path.join(cwd, '.agents', 'skills', 'review'));
      writeSkill(path.join(other, '.agents', 'skills', 'review'));
      captureTeamSkills('codex', '019a0000-0000-7000-8000-0000000000bb', { review: [path.join(cwd, '.agents', 'skills', 'review', 'SKILL.md')] });

      expect(await usedByCodex(config, cwd, [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check the retries' }] },
        call('cat .agents/skills/review/SKILL.md', other),
      ])).toEqual({ skills: [] });
    });

    it('names no team skill the AGENTS.md block Codex injects mentions as $name', async () => {
      const config = await fixture();
      const cwd = path.join(root, 'app');
      plantSkills(cwd, config, ['review'], []);
      writeSkill(path.join(cwd, '.agents', 'skills', 'review'));
      captureTeamSkills('codex', '019a0000-0000-7000-8000-0000000000bb', { review: [path.join(cwd, '.agents', 'skills', 'review', 'SKILL.md')] });

      expect(await usedByCodex(config, cwd, [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: `# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>\nUse $review when reviewing code.\n</INSTRUCTIONS>` }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hello' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] },
      ])).toEqual({ skills: [] });
    });

    it('names no team skill and prints no first prompt from a command record inside the AGENTS.md block Codex injects', async () => {
      const config = await fixture();
      const cwd = path.join(root, 'app');
      plantSkills(cwd, config, ['review'], []);
      writeSkill(path.join(cwd, '.agents', 'skills', 'review'));
      captureTeamSkills('codex', '019a0000-0000-7000-8000-0000000000bb', { review: [path.join(cwd, '.agents', 'skills', 'review', 'SKILL.md')] });
      const printed = vi.spyOn(console, 'log').mockImplementation(() => {});

      expect(await usedByCodex(config, cwd, [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: `# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>\nExample Claude record:\n<command-name>/check</command-name>\n<command-args>Use $review for changes</command-args>\n</INSTRUCTIONS>` }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hello' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] },
      ])).toEqual({ skills: [] });
      expect(printed.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('First prompt: Say hello');
    });

    it('scores the rest of a Codex session whose recorded call has arguments that are not an object', async () => {
      const config = await fixture();
      const cwd = path.join(root, 'app');
      plantSkills(cwd, config, ['review'], []);
      writeSkill(path.join(cwd, '.agents', 'skills', 'review'));
      captureTeamSkills('codex', '019a0000-0000-7000-8000-0000000000bb', { review: [path.join(cwd, '.agents', 'skills', 'review', 'SKILL.md')] });

      expect(await usedByCodex(config, cwd, [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check the retries with $review' }] },
        { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: 'null' },
      ])).toEqual({ skills: ['review'] });
    });

    it('names a team skill only a subagent loaded', async () => {
      const config = await fixture();
      const cwd = path.join(root, 'app');
      plantClaudeSession(cwd, 'Review the change');
      plantSubagentEdit(cwd);
      plantSkills(cwd, config, ['review'], ['review']);
      appendCalls(path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd), SESSION, 'subagents', 'agent-a.jsonl'), cwd, [{ name: 'Skill', input: { skill: 'review' } }], true);

      expect(await usedBy(config)).toEqual({ skills: ['review'] });
    });

    it('names no team skill a load with no time shows when the captures record different deliveries', async () => {
      const config = await fixture();
      const cwd = path.join(root, 'app');
      plantClaudeSession(cwd, 'Review the change');
      plantSubagentEdit(cwd);
      plantSkills(cwd, config, ['review'], ['review']);
      captureTeamSkills('claude-code', SESSION, {}, { captureId: '0b6f2a52-5d7e-4c7e-9a43-6a3c1d0e2f11', capturedAt: '2026-10-20T10:00:05.000Z' });
      fs.appendFileSync(path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd), SESSION, 'subagents', 'agent-a.jsonl'), line({
        type: 'assistant', uuid: 'a3', parentUuid: 'a2', isSidechain: true,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_10', name: 'Skill', input: { skill: 'review' } }] },
      }));

      expect(await usedBy(config)).toEqual({ skills: [] });
    });
  });
});

describe('teamai score --team-session', () => {
  const ALICE_SESSION = 'a11ce000-0000-4000-8000-000000000001';
  // The scorer file sets the current directory first, since it names the repository a session is pushed for.
  beforeEach(() => {
    quality();
  });

  /** Archives a Claude Code session `author` ran, as `teamai session push` does, in the archive at `archive`; returns its session name. */
  async function pushed(archive: string, { author, sessionId = ALICE_SESSION, prompt = 'fix the retry loop in sync.ts', agent }: { author: string; sessionId?: string; prompt?: string; agent?: AgentObservation }): Promise<string> {
    const session: Session = {
      sessionId, title: 'fix the retry loop', cwd: '/home/alice/app', platform: 'claude-code', createdAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-20T11:00:00.000Z',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }, { role: 'assistant', content: [{ type: 'text', text: 'Added the retries.' }] }],
    };
    const meta = defaultSyncMeta({ platform: 'claude-code', author, cwd: session.cwd, sessionId, repoIdentity: getRepoIdentity(process.cwd()), title: session.title, agent }, session.createdAt);
    const saved = await new SyncManager(archive).saveSession(session, meta);
    if (saved.status !== 'written') throw new Error('the archive is busy');
    return path.basename(saved.value, '.jsonl');
  }

  it('judges a session a teammate pushed by its origin, with no agent', async () => {
    const config = await fixture(undefined, 'git');
    const name = await pushed(getReportsDir(config), { author: 'alice' });
    fakeClaude('good');

    expect(data(await tryScorer(config, { teamSession: { name }, scorers: [quality()] }))).toMatchObject({
      label: { subject: { platform: 'claude-code', sessionId: ALICE_SESSION }, label: 'good' },
    });
    expect(fs.readFileSync(path.join(root, 'judged-transcript.md'), 'utf8')).toContain('Added the retries.');
  });

  it('scores a session archived before cwd was relative and agent was recorded', async () => {
    const config = await fixture(undefined, 'git');
    const name = await pushed(getReportsDir(config), { author: 'alice' });
    const metaFile = (fs.readdirSync(getReportsDir(config), { recursive: true }) as string[]).find((file) => file.endsWith(`${name}.meta.json`));
    const file = path.join(getReportsDir(config), metaFile ?? `${name}.meta.json`);
    const meta = JSON.parse(fs.readFileSync(file, 'utf8')) as { origin: Record<string, unknown> };
    fs.writeFileSync(file, JSON.stringify({ ...meta, origin: { ...meta.origin, cwd: '/home/dev/app' } }));
    fakeClaude('good');

    expect(data(await tryScorer(config, { teamSession: { name }, scorers: [quality()] }))).toMatchObject({
      label: { label: 'good', subject: { platform: 'claude-code', sessionId: ALICE_SESSION } },
    });
  });

  it('redacts a session pushed without --scrub before the judge reads it', async () => {
    const config = await fixture(undefined, 'git');
    const token = `glpat-${'x1'.repeat(12)}`;
    const name = await pushed(getReportsDir(config), { author: 'alice', prompt: `deploy with ${token}` });
    fakeClaude('good');

    data(await tryScorer(config, { teamSession: { name }, scorers: [quality()] }));
    const judged = fs.readFileSync(path.join(root, 'judged-transcript.md'), 'utf8');
    expect(judged).toContain('deploy with <REDACTED');
    expect(judged).not.toContain(token);
  });

  it('finds a name on teamai-reports first, else in the archive kept on the default branch before', async () => {
    const config = await fixture(undefined, 'git');
    const legacyOnly = await pushed(config.repo.localPath, { author: 'carol', sessionId: 'c0000000-0000-4000-8000-00000000000c' });
    fakeClaude('good');
    const label = async (name: string, author?: string) => tryScorer(config, { teamSession: { name, ...(author ? { author } : {}) }, scorers: [quality()] });

    expect(data(await label(legacyOnly))).toMatchObject({ label: { subject: { sessionId: 'c0000000-0000-4000-8000-00000000000c' } } });

    const both = await pushed(getReportsDir(config), { author: 'alice' });
    expect(both).toBe(legacyOnly);
    expect(data(await label(both))).toMatchObject({ label: { subject: { sessionId: ALICE_SESSION } } });

    await pushed(getReportsDir(config), { author: 'bob', sessionId: 'b0000000-0000-4000-8000-00000000000b' });
    expect(await label(both)).toEqual({ error: {
      code: 'session_ambiguous', message: `--team-session ${both} names sessions pushed by alice, bob. Pass --author with one of them.`,
    } });
    expect(data(await label(both, 'bob'))).toMatchObject({ label: { subject: { sessionId: 'b0000000-0000-4000-8000-00000000000b' } } });
    expect(await label(both, 'carol')).toEqual({ error: {
      code: 'session_not_found', message: `--team-session ${both} on teamai-reports names sessions pushed by alice, bob, not by carol, and a name found there is read only there. Pass --author with one of them.`,
    } });
  });

  it('names teamai session list when no pushed session has the name', async () => {
    const config = await fixture(undefined, 'git');
    await pushed(getReportsDir(config), { author: 'alice' });

    expect(await tryScorer(config, { teamSession: { name: 'claude-code_no-such-session_20261020' }, scorers: [quality()] })).toEqual({ error: {
      code: 'session_not_found',
      message: `No session claude-code_no-such-session_20261020 is pushed for ${getRepoIdentity(process.cwd()) ?? 'this directory'}. Run teamai session list to see the pushed sessions, after teamai session pull for the newest.`,
    } });
  });

  it('refuses a pushed session that records no session id, since its labels would pair with no run of it', async () => {
    const config = await fixture(undefined, 'git');
    const name = await pushed(getReportsDir(config), { author: 'alice', sessionId: '' });

    expect(await tryScorer(config, { teamSession: { name }, scorers: [quality()] })).toEqual({ error: {
      code: 'session_not_found', message: `The pushed session ${name} records no platform or session id it ran as, so it cannot be scored.`,
    } });
    expect(fs.existsSync(path.join(root, 'data', 'scores', 'labels.jsonl'))).toBe(false);
  });

  it('refuses a team that keeps no session archive, such as an http team', async () => {
    const config = await fixture(undefined, 'http');

    expect(await tryScorer(config, { teamSession: { name: 'claude-code_fix-the-retry-loop_20261020' }, scorers: [quality()] })).toEqual({ error: {
      code: 'unsupported_repo', message: 'This team keeps no session archive here, so it has no pushed session to score. Score a session on this machine with --session <id>.',
    } });
  });
});
