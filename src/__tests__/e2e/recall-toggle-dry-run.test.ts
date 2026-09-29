import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

interface RunResult {
  code: number | null;
  output: string;
}

function runCLI(args: string[], cwd: string, home: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('recall enable/disable --dry-run', () => {
  let sandbox: string;
  let home: string;
  let configPath: string;
  let managedArtifact: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-recall-toggle-dry-run-'));
    home = path.join(sandbox, 'home');
    const teamRepo = path.join(sandbox, 'team-repo');
    configPath = path.join(home, '.teamai', 'config.yaml');
    managedArtifact = path.join(home, '.codex', 'agents', 'teamai-recall.md');

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.mkdirSync(path.join(teamRepo, 'manifest'), { recursive: true });
    fs.mkdirSync(path.dirname(managedArtifact), { recursive: true });
    fs.writeFileSync(configPath, YAML.stringify({
      repo: { localPath: teamRepo, remote: 'local/recall-toggle-e2e' },
      username: 'e2e',
      updatePolicy: 'skip',
      scope: 'user',
      recallEnabled: true,
    }));
    fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), YAML.stringify({
      team: 'recall-toggle-e2e',
      repo: 'local/recall-toggle-e2e',
      provider: 'git',
      sharing: { recall: { enabled: true } },
      toolPaths: { codex: { agents: '.codex/agents' } },
    }));
    // This makes config loading migrate the legacy config on a normal load.
    // A dry-run must pass through the loader's own dry-run path as well.
    fs.writeFileSync(path.join(teamRepo, 'manifest', 'roles.yaml'), [
      'version: 1',
      'roles:',
      '  - id: hai',
      '    resources:',
      '      knowledge: []',
      '      skills: []',
      '      agents: []',
    ].join('\n'));
    fs.writeFileSync(managedArtifact, 'existing managed artifact\n');
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('previews enable and disable without migrating config or touching managed files', async () => {
    const configBefore = fs.readFileSync(configPath, 'utf8');
    const artifactBefore = fs.readFileSync(managedArtifact, 'utf8');

    const disable = await runCLI(['recall', 'disable', '--dry-run'], sandbox, home);
    expect(disable.code, disable.output).toBe(0);
    expect(disable.output).toContain('[dry-run] Would set recallEnabled=false');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(configBefore);
    expect(fs.readFileSync(managedArtifact, 'utf8')).toBe(artifactBefore);

    const enable = await runCLI(['recall', 'enable', '--dry-run'], sandbox, home);
    expect(enable.code, enable.output).toBe(0);
    expect(enable.output).toContain('[dry-run] Would set recallEnabled=true');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(configBefore);
    expect(fs.readFileSync(managedArtifact, 'utf8')).toBe(artifactBefore);
  });
});
