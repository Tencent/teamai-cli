import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { loadTeamConfig } from '../config.js';
import { SessionPolicy } from '../session-flow/session-policy.js';
import { LocalConfigSchema, type LocalConfig } from '../types.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A git team whose `teamai.yaml` adds `teamYaml`, and a member `config.yaml` that adds `memberYaml`, each read as teamai reads it. */
async function scope({ teamYaml = '', memberYaml = '', kind = 'git' }: { teamYaml?: string; memberYaml?: string; kind?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-session-policy-'));
  dirs.push(root);
  fs.writeFileSync(path.join(root, 'teamai.yaml'), `team: t\nrepo: https://example.com/t.git\n${teamYaml}`);
  const member: unknown = YAML.parse(`repo: { localPath: ${JSON.stringify(root)}, remote: origin, kind: ${kind} }\nusername: tester\n${memberYaml}`);
  const config: LocalConfig = LocalConfigSchema.parse(member);
  return { config, team: await loadTeamConfig(root) };
}

describe('SessionPolicy.publish', () => {
  it('offers attended sessions and publishes unattended ones when nothing sets sessions.publish', async () => {
    const { config, team } = await scope();

    expect(SessionPolicy.publish(config, team)).toEqual({
      policies: { attended: { policy: 'ask', source: { kind: 'default' } }, unattended: { policy: 'auto', source: { kind: 'default' } } },
      problems: [],
    });
  });

  it('takes each mode from the member config.yaml, else teamai.yaml, else the default', async () => {
    const { config, team } = await scope({ teamYaml: 'sessions:\n  publish: { attended: auto, unattended: off }\n', memberYaml: 'sessions:\n  publish: { attended: off }\n' });

    expect(SessionPolicy.publish(config, team).policies).toEqual({
      attended: { policy: 'off', source: { kind: 'setting', key: 'config.yaml sessions.publish.attended' } },
      unattended: { policy: 'off', source: { kind: 'setting', key: 'teamai.yaml sessions.publish.unattended' } },
    });
  });

  it('reports a value it cannot use and ignores it, and neither file fails to load', async () => {
    const { config, team } = await scope({ teamYaml: 'sessions:\n  publish: { unattended: yes }\n', memberYaml: 'sessions: { publish: { attended: always, nightly: auto } }\n' });

    expect(team).not.toBeNull();
    expect(SessionPolicy.publish(config, team)).toEqual({
      policies: { attended: { policy: 'ask', source: { kind: 'default' } }, unattended: { policy: 'auto', source: { kind: 'default' } } },
      problems: [
        'config.yaml sessions.publish.attended is "always", not off, ask or auto, so it is ignored',
        'config.yaml sessions.publish.nightly is not a run mode (attended, unattended), so it is ignored',
        'teamai.yaml sessions.publish.unattended is "yes", not off, ask or auto, so it is ignored',
      ],
    });
  });

  it('reports a sessions value that is not a mapping, and ignores it', async () => {
    const { config, team } = await scope({ teamYaml: 'sessions: publish\n' });

    expect(team).not.toBeNull();
    expect(SessionPolicy.publish(config, team).problems).toEqual(['teamai.yaml sessions is "publish", not a mapping such as publish: { unattended: off }, so it is ignored']);
  });

  it('publishes nothing on an HTTP team, and says so while a mode would publish', async () => {
    const { config, team } = await scope({ kind: 'http', memberYaml: 'sessions: { publish: { attended: auto } }\n' });
    const off = { policy: 'off', source: { kind: 'http-team' } };

    expect(SessionPolicy.publish(config, team)).toEqual({
      policies: { attended: off, unattended: off },
      problems: ['Sessions are not published: the team repo is an HTTP repo, which keeps no session archive, so sessions.publish acts as off'],
    });
    expect(SessionPolicy.publish({ ...config, sessions: { publish: { attended: 'off', unattended: 'off' } } }, team)).toMatchObject({ problems: [] });
  });
});
