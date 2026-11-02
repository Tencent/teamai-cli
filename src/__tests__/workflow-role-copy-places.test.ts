/**
 * A workflow copy that runs with a team role gets that role's knowledge only inside itself: teamai refuses the step
 * before delivering anything when a tool it delivers to would take knowledge from a place outside the copy, or when the
 * team docs would land outside it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LAUNCH_TOOLS } from '../tool-launch/tools.js';
import { TeamaiConfigSchema, type LocalConfig, type TeamaiConfig } from '../types.js';
import { roleCopyRefusal } from '../workflow/place/role-copy.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-role-copy-')));
  dirs.push(dir);
  return dir;
}

function teamWith(sharing: Record<string, unknown> = {}): TeamaiConfig {
  return TeamaiConfigSchema.parse({ team: 'acme', repo: 'https://github.com/acme/team.git', provider: 'git', sharing });
}

/** The project install of `copy` that delivers to `tool`, as a clone's own install writes it. */
function installOf(copy: string, tool: string): LocalConfig {
  return { repo: { localPath: path.join(copy, '..', 'team-repo'), remote: 'local' }, username: 'member', scope: 'project', additionalRoles: [], projectRoot: copy, dataHome: path.join(copy, '..', 'data'), enabledAgents: [tool] };
}

describe('the places a copy that runs with a team role takes knowledge in', () => {
  it.each(LAUNCH_TOOLS)('admits %s, which takes every piece of knowledge inside the copy by default', async (tool) => {
    const copy = tmp();

    expect(await roleCopyRefusal({ team: teamWith(), install: installOf(copy, tool), role: 'review' })).toBeUndefined();
  });

  it('refuses a copy whose team docs land outside it, where every checkout reads them', async () => {
    const copy = tmp();
    const shared = path.join(tmp(), 'team-docs');

    expect(await roleCopyRefusal({ team: teamWith({ docs: { localDir: shared } }), install: installOf(copy, 'claude'), role: 'review' })).toEqual({
      code: 'role_unavailable',
      message: `Role review was not delivered into ${copy}: the team docs land in ${shared}, outside the copy, where every checkout would read them. Set sharing.docs.localDir in teamai.yaml to a directory inside the project, such as .teamai/docs, or run the step without a role.`,
    });
  });
});
