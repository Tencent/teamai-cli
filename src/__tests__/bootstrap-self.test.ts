import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { bootstrapSelfRepo } from '../bootstrap.js';
import { detectProjectConfig } from '../config.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-bootstrap-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('bootstrapSelfRepo', () => {
  it("returns 'skip' when there is no .teamai/teamai.yaml (not a teamai project)", async () => {
    const result = await bootstrapSelfRepo(tmpDir, { silent: true });
    expect(result).toBe('skip');
  });

  it("returns 'skip' when teamai.yaml exists but has no mode: self (standalone team repo marker absent)", async () => {
    const teamaiDir = path.join(tmpDir, '.teamai');
    fs.mkdirSync(teamaiDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamaiDir, 'teamai.yaml'),
      YAML.stringify({ team: 'x', repo: 'https://github.com/acme/app.git' }),
    );
    const result = await bootstrapSelfRepo(tmpDir, { silent: true });
    expect(result).toBe('skip');
  });

  it("returns 'already' when a local config.yaml is already present", async () => {
    const teamaiDir = path.join(tmpDir, '.teamai');
    fs.mkdirSync(teamaiDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamaiDir, 'teamai.yaml'),
      YAML.stringify({ team: 'x', mode: 'self', repo: 'https://github.com/acme/app.git' }),
    );
    fs.writeFileSync(
      path.join(teamaiDir, 'config.yaml'),
      YAML.stringify({
        repo: { localPath: teamaiDir, remote: 'r', kind: 'self' },
        username: 'alice',
        scope: 'project',
        projectRoot: tmpDir,
      }),
    );
    const result = await bootstrapSelfRepo(tmpDir, { silent: true });
    expect(result).toBe('already');
  });
});

describe('detectProjectConfig self-heal', () => {
  it('returns null (no crash) for a self-mode marker when a provider cannot be derived', async () => {
    // teamai.yaml has mode: self but no repo field, and the temp dir is not inside
    // a git repo — so there is no remote to derive a provider from. The
    // non-interactive bootstrap degrades to skip and detect returns null without
    // writing a config. (Deterministic regardless of local gh/git auth.)
    const teamaiDir = path.join(tmpDir, '.teamai');
    fs.mkdirSync(teamaiDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamaiDir, 'teamai.yaml'),
      YAML.stringify({ team: 'x', mode: 'self' }),
    );
    const result = await detectProjectConfig(tmpDir);
    expect(result).toBeNull();
    // Must NOT have written a config (bootstrap did not complete).
    expect(fs.existsSync(path.join(teamaiDir, 'config.yaml'))).toBe(false);
  });

  it('returns the config when config.yaml already exists (no bootstrap needed)', async () => {
    const teamaiDir = path.join(tmpDir, '.teamai');
    fs.mkdirSync(teamaiDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamaiDir, 'config.yaml'),
      YAML.stringify({
        repo: { localPath: teamaiDir, remote: 'r', kind: 'self', businessRepoRoot: tmpDir },
        username: 'alice',
        scope: 'project',
        projectRoot: tmpDir,
      }),
    );
    const result = await detectProjectConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result?.repo.kind).toBe('self');
    expect(result?.username).toBe('alice');
  });
});
