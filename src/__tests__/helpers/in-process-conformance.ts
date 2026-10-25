/** A scenario's runner over the in-process client, and what the in-process and CLI clients must answer alike. */
import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import { resolveWorkflowEnv } from '../../env-resolution.js';
import type { LocalConfig } from '../../types.js';
import { syncWorkflowDefinitions } from '../../workflow/cache.js';
import { inProcessConformanceClient, type ConformanceClient, type ConformanceRunner, type ConformanceScenario } from '../../workflow/conformance-interpreter.js';
import { inProcessClient } from '../../workflow/protocol.js';
import { pendingRecords } from '../../workflow/records.js';
import { readRun } from '../../workflow/store.js';
import type { WorkflowEnvelope } from '../../workflow/types.js';

/**
 * Installs `scenario` under `root` with its env stubbed, and its runner over the in-process client on a fake Date. The
 * caller restores the env and the clock. `places` names the directories the run's envelopes can name.
 */
export async function inProcessConformanceRunner(scenario: ConformanceScenario, root: string): Promise<{ runner: Omit<ConformanceRunner, 'expect'>; places: Record<string, string> }> {
  for (const [name, value] of Object.entries(scenario.env ?? {})) vi.stubEnv(name, value);
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
  return {
    runner: {
      client: inProcessConformanceClient(inProcessClient({ config, env: await resolveWorkflowEnv(config) })),
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
      start: (name, options) => keep('start', client.start(name, options)),
      next: (runId, body, options) => keep('next', client.next(runId, body, options)),
      report: (runId, body, options) => keep('report', client.report(runId, body, options)),
      respond: (runId, step, choice, options) => keep('respond', client.respond(runId, step, choice, options)),
      retry: (runId, step) => keep('retry', client.retry(runId, step)),
      cancel: (runId, step) => keep('cancel', client.cancel(runId, step)),
    },
  };
}

/**
 * `value` with what two installs of one scenario cannot share named instead: run and attempt ids, times, and each of
 * `places`, by its key, whether as given or as its real path.
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
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<time>');
  return JSON.parse(text);
}
