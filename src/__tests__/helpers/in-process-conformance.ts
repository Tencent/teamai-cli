/** A scenario's runner over the in-process client, and what the in-process and CLI clients must answer alike. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import { resolveWorkflowEnv } from '../../env-resolution.js';
import type { LocalConfig } from '../../types.js';
import { redactJson } from '../../utils/redact.js';
import { syncWorkflowDefinitions } from '../../workflow/cache.js';
import { inProcessConformanceClient, type ConformanceClient, type ConformanceRunner, type ConformanceScenario } from '../../workflow/conformance-interpreter.js';
import { inProcessClient } from '../../workflow/protocol.js';
import { pendingRecords } from '../../workflow/records.js';
import { readRun } from '../../workflow/store.js';
import type { WorkflowEnvelope } from '../../workflow/types.js';

/** The origin of the CLI conformance install, where nothing listens. */
export const UNREACHABLE_ORIGIN = 'http://127.0.0.1:9/team/workflow.git';

/**
 * Installs `scenario` under `root` with its env stubbed, and its runner over the in-process client on a fake Date. The
 * caller restores the env and the clock. `places` names the directories the run's envelopes can name. With `checkout`,
 * `root` is a git checkout every run starts from, as `teamai workflow start` starts from its cwd, whose origin no one
 * answers, as the CLI conformance install's; `printed` is what the CLI prints of an envelope, the team's secrets masked.
 */
export async function inProcessConformanceRunner(scenario: ConformanceScenario, root: string, options: { checkout?: true } = {}): Promise<{
  runner: Omit<ConformanceRunner, 'expect'>; places: Record<string, string>; printed: (value: unknown) => unknown;
}> {
  for (const [name, value] of Object.entries(scenario.env ?? {})) vi.stubEnv(name, value);
  if (options.checkout) {
    const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: root, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
    git('add', 'README.md');
    git('commit', '-qm', 'initial');
    git('remote', 'add', 'origin', UNREACHABLE_ORIGIN);
  }
  const knowledge = path.join(root, 'knowledge');
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  const config: LocalConfig = {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester',
    scope: 'project',
    additionalRoles: [],
    projectRoot: root,
    dataHome: data,
  };
  fs.writeFileSync(path.join(knowledge, 'workflows', `${scenario.workflowName}.yaml`), scenario.yaml);
  for (const [name, yaml] of Object.entries(scenario.workflows ?? {})) {
    fs.writeFileSync(path.join(knowledge, 'workflows', `${name}.yaml`), yaml);
  }
  await syncWorkflowDefinitions(config);
  const env = await resolveWorkflowEnv(config);
  const client = inProcessConformanceClient(inProcessClient({ config, env }));
  return {
    runner: {
      client: options.checkout ? { ...client, start: (name, start) => client.start(name, { ...start, checkout: root }) } : client,
      readRun: async (runId) => {
        const stored = await readRun(config, runId);
        if (typeof stored !== 'object') throw new Error('run was not stored');
        return stored;
      },
      readEndRecord: async (runId) => (await pendingRecords(config)).find((record) => record.run === runId && record.phase === 'end'),
      // Only Date is faked, so the run lock's retry timers still run.
      advance: async (ms) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + ms);
      },
    },
    places: { knowledge, data, project: root },
    printed: (value) => redactJson(value, env.secrets),
  };
}

/** `client`, and every envelope it answered, in order, with the call that answered it. */
export function recorded(client: ConformanceClient): { client: ConformanceClient; envelopes: Array<{ call: keyof ConformanceClient; envelope: WorkflowEnvelope }> } {
  const envelopes: Array<{ call: keyof ConformanceClient; envelope: WorkflowEnvelope }> = [];
  const keep = async (call: keyof ConformanceClient, answer: Promise<WorkflowEnvelope>): Promise<WorkflowEnvelope> => {
    const envelope = await answer;
    envelopes.push({ call, envelope });
    return envelope;
  };
  return {
    envelopes,
    client: {
      start: (name, options) => keep('start', client.start(name, options).then((envelope) => (options?.driver === 'skill' ? withoutSkillNext(envelope) : envelope))),
      next: (runId, body, options) => keep('next', client.next(runId, body, options)),
      report: (runId, body, options) => keep('report', client.report(runId, body, options)),
      respond: (runId, step, choice, options) => keep('respond', client.respond(runId, step, choice, options)),
      retry: (runId, step) => keep('retry', client.retry(runId, step)),
      cancel: (runId, step) => keep('cancel', client.cancel(runId, step)),
    },
  };
}

/** The skill driver adds `next` to every error it answers through the CLI; the in-process client has no skill driver. */
function withoutSkillNext(envelope: WorkflowEnvelope): WorkflowEnvelope {
  if (!('error' in envelope) || !('next' in envelope.error)) return envelope;
  const { next: _next, ...error } = envelope.error;
  return { error };
}

/**
 * `value` with what two installs of one scenario cannot share named instead: run and attempt ids, commits, times, how
 * long git took to fail to connect, and each of `places`, by its key, whether as given or as its real path.
 */
export function normalized(value: unknown, places: Record<string, string>): unknown {
  const named = Object.entries(places)
    .flatMap(([name, place]): Array<[string, string]> => [[name, place], [name, fs.existsSync(place) ? fs.realpathSync(place) : place]])
    .sort(([, left], [, right]) => right.length - left.length);
  let text = JSON.stringify(value);
  for (const [name, place] of named) text = text.split(JSON.stringify(place).slice(1, -1)).join(`<${name}>`);
  text = text
    .replace(/\br[0-9a-f]{16}\b|\br[0-9a-f]{8}\b/g, '<run>')
    .replace(/\ba[0-9a-f]{8}\b/g, '<attempt>')
    .replace(/\b[0-9a-f]{40}\b/g, '<commit>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<time>')
    .replace(/ after \d+ ms/g, ' after <ms> ms');
  return JSON.parse(text);
}
