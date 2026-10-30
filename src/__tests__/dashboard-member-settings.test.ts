import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { refreshRoleAssignment } from '../config.js';
import { readMemberSettingsPanel } from '../dashboard/member-settings.js';
import { getUserConfigPath, LocalConfigSchema, type LocalConfig } from '../types.js';

const dirs: string[] = [];
const machineFile = getUserConfigPath;

afterEach(() => {
  fs.rmSync(machineFile(), { force: true });
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A workspace whose own config.yaml adds `workspaceYaml`, loaded with the machine file below it as teamai loads it. */
async function workspace(workspaceYaml: string): Promise<{ config: LocalConfig; scopeFile: string }> {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-member-settings-')));
  dirs.push(root);
  const team = path.join(root, 'team');
  fs.mkdirSync(team);
  fs.writeFileSync(path.join(team, 'teamai.yaml'), 'team: t\nrepo: https://example.com/t.git\n');
  const dataHome = path.join(root, 'data');
  const scopeFile = path.join(dataHome, 'config.yaml');
  fs.mkdirSync(dataHome);
  const yaml = `repo: { localPath: ${JSON.stringify(team)}, remote: origin }\nusername: tester\nscope: workspace\nprojectRoot: ${JSON.stringify(root)}\n${workspaceYaml}`;
  fs.writeFileSync(scopeFile, yaml);
  const config: LocalConfig = { ...LocalConfigSchema.parse(YAML.parse(yaml)), dataHome };
  await refreshRoleAssignment(config);
  return { config, scopeFile };
}

describe('readMemberSettingsPanel', () => {
  it('lists each member setting a level sets, the level that won, and the levels below it', async () => {
    fs.mkdirSync(path.dirname(machineFile()), { recursive: true });
    fs.writeFileSync(machineFile(), 'ai: { tool: codex }\nrecallEnabled: true\nworkflows: { tools: { default: codex } }\nexcludedSkills: [lint]\n');
    const { config, scopeFile } = await workspace('ai: { tool: claude }\nrecallEnabled: false\n');

    const read = await readMemberSettingsPanel(config);

    expect(read).toMatchObject({ configured: true, scope: 'workspace', machineFile: machineFile(), unread: ['excludedSkills'] });
    expect(read.configured && read.rows).toEqual(expect.arrayContaining([
      { key: 'ai.tool', value: 'claude', source: { level: 'scope', value: 'claude', file: scopeFile }, below: [{ level: 'machine', value: 'codex', file: machineFile() }], unused: [] },
      expect.objectContaining({ key: 'recallEnabled', value: false, source: { level: 'scope', value: false, file: scopeFile }, below: [{ level: 'machine', value: true, file: machineFile() }] }),
      { key: 'workflows.tools.default', value: 'codex', source: { level: 'machine', value: 'codex', file: machineFile() }, below: [], unused: [] },
    ]));
  });

  it('shows the 0 a member writes to opt out of auto-compact', async () => {
    const { config, scopeFile } = await workspace('autoCompactTokens: 0\n');

    const read = await readMemberSettingsPanel(config);

    expect(read.configured && read.rows).toContainEqual(
      { key: 'autoCompactTokens', value: 0, source: { level: 'scope', value: 0, file: scopeFile }, below: [], unused: [] },
    );
  });

  it('leaves a user install whose legacy role migration is pending as it is', async () => {
    const { config } = await workspace('');
    const team = config.repo.localPath;
    fs.mkdirSync(path.join(team, 'manifest'), { recursive: true });
    fs.writeFileSync(path.join(team, 'manifest', 'roles.yaml'), 'version: 1\nroles:\n  - id: hai\n    resources: { knowledge: [], skills: [hai] }\n');
    fs.mkdirSync(path.dirname(machineFile()), { recursive: true });
    fs.writeFileSync(machineFile(), `repo: { localPath: ${JSON.stringify(team)}, remote: origin }\nusername: tester\n`);
    const before = fs.readFileSync(machineFile(), 'utf8');

    await readMemberSettingsPanel(config);

    expect(fs.readFileSync(machineFile(), 'utf8')).toBe(before);
  });
});
