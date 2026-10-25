import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runsDir } from '../workflow/store.js';
import { skillHarness } from './helpers/skill-harness.js';

const RELEASE_DOCS = `schemaVersion: v1alpha1
name: release-docs
description: Draft the release notes, then sign them
invoke: allow
steps:
  - id: docs
    workspace: new
    workflow:
      steps:
        - id: draft
          prompt: Draft the release notes.
        - id: sign
          needs: [draft]
          prompt: Sign the notes.
          requires: { env: [SIGNING_KEY] }
`;

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function harness(workflows: Record<string, string>) {
  const made = await skillHarness(workflows);
  roots.push(made.root);
  return made;
}

/** How many runs this machine has. */
function runCount(made: Awaited<ReturnType<typeof harness>>): number {
  return fs.existsSync(runsDir(made.config)) ? fs.readdirSync(runsDir(made.config)).length : 0;
}

describe('skill driver preflight', () => {
  it('routes a run whose continue step needs env to the local driver', async () => {
    const made = await harness({ 'release-docs': RELEASE_DOCS });
    expect(await made.call({ kind: 'describe', name: 'release-docs' })).toMatchObject({ data: { describe: {
      workflow: { facts: { localRoute: { opener: 'docs', held: 'docs.sign', missing: 'env' } } },
      ask: { kind: 'local', start: 'teamai workflow start release-docs --driver local' },
    } } });
    expect(await made.call({ kind: 'start', name: 'release-docs', answers: { confirmed: false }, inputs: undefined }))
      .toMatchObject({ error: { code: 'needs_local_driver', next: null } });
    expect(runCount(made)).toBe(0);
  });
});
