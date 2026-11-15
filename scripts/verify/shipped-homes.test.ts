import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ledgerRules } from './ledger.js';
import { movedShippedHomes, recordedShippedHomes, recordShippedHomes } from './shipped-homes.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);

  return dir;
}

/** An install whose user config records `.codex-work` as the Codex root, as `init` does with CODEX_HOME exported. */
function installWithCodexRoot(): { home: string; config: string } {
  const home = tempDir('shipped-homes-');
  const config = path.join(home, '.teamai', 'config.yaml');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, `repo:\n  localPath: ${path.join(home, '.teamai', 'team-repo')}\n  remote: https://teamai.test/team/repo.git\nscope: user\nenabledAgents:\n  - codex\ntoolRoots:\n  codex: ${path.join(home, '.codex-work')}\n`);

  return { home, config };
}

describe("where a world's command finds a shipped tool's home moved", () => {
  it('is the root init recorded for it in toolRoots, from a command without its variable', () => {
    const { home } = installWithCodexRoot();

    expect(movedShippedHomes(home, { env: {}, cwd: home })).toEqual([{ tool: 'codex', home: '.codex-work' }]);
  });

  it('is the home recorded in ~/.teamai/tool-homes.json, and the one the command\'s variable names', () => {
    const home = tempDir('shipped-homes-');
    fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(home, '.teamai', 'tool-homes.json'), JSON.stringify({ codebuddy: path.join(home, 'work', 'codebuddy') }));

    const found = movedShippedHomes(home, { env: { CODEX_HOME: path.join(home, 'work', 'codex') }, cwd: home });

    expect(found.toSorted((a, b) => a.tool.localeCompare(b.tool))).toEqual([{ tool: 'codebuddy', home: 'work/codebuddy' }, { tool: 'codex', home: 'work/codex' }]);
  });

  it('is none for a home outside HOME, or the tool\'s own', () => {
    const home = tempDir('shipped-homes-');

    expect(movedShippedHomes(home, { env: { CODEX_HOME: tempDir('elsewhere-'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') }, cwd: home })).toEqual([]);
  });

  it('stays in the world\'s record after uninstall removed what recorded it', () => {
    const world = { dir: tempDir('shipped-world-') };
    const { home, config } = installWithCodexRoot();
    recordShippedHomes(world, home, movedShippedHomes(home, { env: {}, cwd: home }));
    recordShippedHomes(world, home, movedShippedHomes(home, { env: {}, cwd: home }));
    fs.rmSync(config);

    expect(movedShippedHomes(home, { env: {}, cwd: home })).toEqual([]);
    expect(recordedShippedHomes(world, home)).toEqual([{ tool: 'codex', home: '.codex-work' }]);
    expect(recordedShippedHomes(world, path.join(home, 'other'))).toEqual([]);
  });
});

describe('what uninstall leaves in a Codex home init recorded through toolRoots', () => {
  const sha = 'f'.repeat(64);
  const moved = 'home/.codex-work';
  const rules = () => ledgerRules([], [{ tool: 'codex', home: '.codex-work' }]);

  // Codex's own state, judged exactly as the same entry in ~/.codex.
  it.each([
    ['sessions/2026/11/14/rollout.jsonl', sha],
    ['sessions', 'dir'],
    ['tmp/arg0', 'dir'],
    // What teamai delivers there: never the tool's, a LEAK as in ~/.codex.
    ['hooks.json', sha],
    ['skills/hello-world/SKILL.md', sha],
    ['config.toml', sha],
  ])('judges %s holding %s as the same entry in Codex\'s own home', (entry, value) => {
    const judged = rules();
    const base = judged.ownStateOf(`home/.codex/${entry}`, value);

    expect(judged.ownStateOf(`${moved}/${entry}`, value)).toEqual(base === undefined ? undefined : { ...base, dir: moved });
    expect(judged.knownLeftover(`${moved}/${entry}`)).toBe(judged.knownLeftover(`home/.codex/${entry}`));
  });

  it("excuses Codex's state there, keeps the home it reads, and keeps teamai's a LEAK", () => {
    const judged = rules();

    expect(judged.ownStateOf(`${moved}/sessions/2026/11/14/rollout.jsonl`, sha)).toEqual({ kind: 'state', owner: 'the tool', dir: moved });
    expect(judged.knownLeftover(moved)).toBe('dir');
    expect([`${moved}/hooks.json`, `${moved}/skills/hello-world/SKILL.md`].map((entry) => judged.ownStateOf(entry, sha))).toEqual([undefined, undefined]);
  });

  it('excuses nothing there for an install that recorded no such home', () => {
    expect(ledgerRules([]).ownStateOf(`${moved}/sessions/2026/11/14/rollout.jsonl`, sha)).toBeUndefined();
    expect(ledgerRules([]).knownLeftover(moved)).toBeUndefined();
  });
});
