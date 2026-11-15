import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toolInstancesIn } from './instances.js';
import { environmentNotes, hostHomes, hostUnreadableNote, ledgerRules, ledgerVerdict, namingWorld, uninstallChanges, unobservedEntries } from './ledger.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("a ledger's verdict", () => {
  const section = (leaks: string[], notes: string[]) => ({ title: '(x)', leaks, notes });

  it.each([
    { when: 'it found no LEAK and observed every part', sections: [section([], ['none']), section([], ['HOME and project match the world as it was made'])], verdict: 'CLEAN' },
    {
      when: 'it found no LEAK and some part is NOT OBSERVED, a member\'s too',
      sections: [section([], ['NOT OBSERVED: podman containers, podman info failed']), section([], ["@carol NOT OBSERVED: home/.codex/sessions/0000, which the harness has no permission to read, so whether uninstall left anything of teamai's in it is unknown"])],
      verdict: 'no LEAK, 2 NOT OBSERVED',
    },
    { when: 'it found a LEAK', sections: [section(['home/.teamai left behind'], ['NOT OBSERVED: podman containers, podman info failed'])], verdict: '1 LEAK' },
    { when: 'it found LEAKs', sections: [section(['a', 'b'], [])], verdict: '2 LEAKS' },
    { when: 'a note only mentions the words', sections: [section([], ['the tool said NOT OBSERVED once'])], verdict: 'CLEAN' },
  ])('is $verdict when $when', ({ sections, verdict }) => {
    expect(ledgerVerdict(sections)).toBe(verdict);
  });
});

describe("section (c)'s walk of a tool home", () => {
  const world = { runId: '20261114T000000-abcdef', dir: '/w/20261114T000000-abcdef' };
  const toolHome = (): { home: string; folder: string } => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-walk-'));
    roots.push(home);
    const folder = path.join(home, 'projects');
    fs.mkdirSync(folder);

    return { home, folder };
  };
  const failing = (folder: string, code: string) => vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike, _options: { withFileTypes: true }) => {
    if (dir.toString() === folder) throw Object.assign(new Error(`${code}: scandir '${folder}'`), { code, path: folder });
    const listing = fs.opendirSync(dir.toString());
    const entries: fs.Dirent[] = [];

    for (let entry = listing.readSync(); entry !== null; entry = listing.readSync()) entries.push(entry);
    listing.closeSync();

    return entries;
  }) as typeof fs.readdirSync);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['EACCES', 'EPERM'])('counts a folder it may not list (%s) as unreadable, for the time rule to judge', (code) => {
    const { home, folder } = toolHome();
    failing(folder, code);
    const unreadable: string[] = [];

    namingWorld(home, world, 0, [], unreadable);

    expect(unreadable).toEqual([folder]);
  });

  it.skipIf(process.platform === 'win32')('counts a link that leads back to itself as unreadable, for the time rule to judge, rather than fail the ledger', () => {
    const { home, folder } = toolHome();
    const link = path.join(folder, 'loop');
    fs.symlinkSync(link, link);
    const unreadable: string[] = [];

    namingWorld(home, world, 0, [], unreadable);

    expect(unreadable).toEqual([link]);
  });

  it('fails the ledger, naming the folder and the error, on any other failure to list it, as running out of file handles', () => {
    const { home, folder } = toolHome();
    failing(folder, 'EMFILE');
    const unreadable: string[] = [];

    expect(() => namingWorld(home, world, 0, [], unreadable)).toThrow(`Section (c) could not read ${folder}: EMFILE: scandir '${folder}'`);
    expect(unreadable).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')("a folder of the real HOME section (c) cannot read", () => {
  const unlistable = (mtime: Date): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-host-'));
    roots.push(root);
    const folder = path.join(root, '.Trashes');
    fs.mkdirSync(folder);
    fs.utimesSync(folder, mtime, mtime);
    // As macOS leaves one: this user can write and enter it, and cannot list it.
    fs.chmodSync(folder, 0o300);

    return folder;
  };
  const born = Date.parse('2026-11-13T12:00:00.000Z');

  it('is NOT OBSERVED when it changed since the world was made, since a file the world wrote in it would change it', () => {
    const folder = unlistable(new Date(born + 60_000));

    try {
      expect(hostUnreadableNote(folder, born)).toBe(`NOT OBSERVED: ${folder}, which the harness cannot read and which changed since the world was made, so whether it names the world is unknown`);
    } finally {
      fs.chmodSync(folder, 0o700);
    }
  });

  it('is a note, not NOT OBSERVED, when it has not changed since the world was made', () => {
    const folder = unlistable(new Date(born - 86_400_000));

    try {
      expect(hostUnreadableNote(folder, born)).toBe(`not readable, and unchanged since the world was made, so not checked: ${folder}`);
    } finally {
      fs.chmodSync(folder, 0o700);
    }
  });

  it('is NOT OBSERVED when the harness cannot even tell when it changed', () => {
    expect(hostUnreadableNote('/nonexistent-ledger-host/x', born)).toMatch(/^NOT OBSERVED: \/nonexistent-ledger-host\/x, /);
  });
});

describe("a ledger's section (d)", () => {
  it("names the variables the world's commands got and those of each member's, never a value", () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-env-'));
    roots.push(bin);
    fs.writeFileSync(path.join(bin, 'run'), "#!/bin/sh\nexec env -i HOME='/w/home' PATH='/w/bin' \"$@\"\n");
    const place = { home: '/w/m/carol/home', project: '/w/m/carol/project', tmp: '/tmp/carol', writers: '/w/m/carol/writers.json', baseline: { files: {} } };

    const notes = environmentNotes({ bin, members: [{ machine: 'container', container: 'teamai-verify-x-carol', name: 'carol', env: { HOME: '/w/m/carol/home', PATH: '/usr/bin', SECRET_VALUE_NAME: 'v4lue-not-shown' }, ...place }] });

    expect(notes).toEqual(['commands got only: HOME, PATH', "@carol's commands got only: HOME, PATH, SECRET_VALUE_NAME"]);
    expect(notes.join('\n')).not.toContain('v4lue');
  });
});

describe("what a ledger's section (e) could not read", () => {
  const sha = (c: string) => c.repeat(64);

  it('is NOT OBSERVED with everything under it, never a match, and hides no change beside it', () => {
    const before = { 'home/.codex/sessions/0000': 'dir', 'home/.codex/sessions/0000/rollout.jsonl': sha('a'), 'home/secret.txt': sha('b'), 'home/notes.txt': sha('c') };
    const after = { 'home/.codex/sessions/0000': 'unreadable', 'home/secret.txt': 'unreadable', 'home/notes.txt': sha('d') };

    const unobserved = unobservedEntries(before, after);

    expect(unobserved.notes).toEqual([
      "NOT OBSERVED: home/.codex/sessions/0000, which the harness has no permission to read, so whether uninstall left anything of teamai's in it is unknown",
      "NOT OBSERVED: home/secret.txt, which the harness has no permission to read, so whether uninstall left anything of teamai's in it is unknown",
    ]);
    expect(['home/.codex/sessions/0000', 'home/.codex/sessions/0000/rollout.jsonl', 'home/secret.txt'].every(unobserved.covers)).toBe(true);
    expect(unobserved.covers('home/notes.txt')).toBe(false);
    expect(unobserved.covers('home/.codex/sessions/00000')).toBe(false);
  });

  it('is nothing when the harness read every entry', () => {
    expect(unobservedEntries({ 'home/a': sha('a') }, { 'home/a': sha('b') }).notes).toEqual([]);
  });

  it.each<{ change: string; before: Record<string, string>; after: Record<string, string> }>([
    { change: 'left behind', before: {}, after: { 'home/left': 'unreadable' } },
    { change: 'removed', before: { 'home/gone': 'unreadable' }, after: {} },
  ])('is observed, for the ledger to judge as any entry, when uninstall $change it: whether it exists is known', ({ before, after }) => {
    const unobserved = unobservedEntries(before, after);
    const [entry = ''] = [...Object.keys(before), ...Object.keys(after)];

    expect(unobserved.notes).toEqual([]);
    expect(unobserved.covers(entry)).toBe(false);
  });
});

describe("a tool's own state file in a ledger's section (e)", () => {
  it.each([
    ['home/.claude.json', '{"numStartups":1,"projects":{"/w/project":{"allowedTools":[]}}}', true],
    ['home/.claude.json', '{"mcpServers":{}}', true],
    ['home/.claude.json', '{"projects":{"/private/var/folders/x/T/teamai-verify/20261112T120000-aaaaaa/project":{"allowedTools":[]}}}', true],
    ['home/.claude.json', '{"mcpServers":{"docs":{"command":"node"}}}', false],
    ['home/.claude.json', '{"projects":{"/w/project":{"mcpServers":{"docs":{"command":"node"}}}}}', false],
    ['home/.claude.json', '{"hooks":"teamai hook"}', false],
    ['home/.claude.json', 'not json', false],
    ['home/.codebuddy.json', '{"numStartups":1}', true],
    ['home/.codebuddy.json', '{"projects":{"/w/project":{"mcpServers":{"docs":{"command":"node"}}}}}', false],
    ['home/.other.json', '{}', false],
  ])('judges %s holding %s as the tool\'s own: %s', (entry, text, own) => {
    expect(ledgerRules([]).isToolOwnState(entry, text)).toBe(own);
  });
});

describe("another program's own state in a ledger's section (e)", () => {
  const SBX = 'home/Library/Application Support/com.docker.sandboxes';
  const SBX_CACHE = 'home/Library/Caches/com.docker.sandboxes';
  const sha = 'f'.repeat(64);

  it.each([
    ['home/.claude/projects/-w-project/s.jsonl', sha, { kind: 'state', owner: 'the tool', dir: 'home/.claude' }],
    ['home/.claude', 'dir', undefined],
    ['home/.claude/skills/teamai-share/SKILL.md', sha, undefined],
    ['project/.git/refs/heads/main', 'f'.repeat(40), undefined],
    // T3 Code checkpoints a thread's project under refs/t3 (its CheckpointService and git driver).
    ['project/.git/refs/t3/checkpoints/turns/1', sha, { kind: 'state', owner: 'T3 Code', dir: 'project/.git/refs/t3' }],
    ['project/.git/refs/t3/orchestration-v2/checkpoints/x', sha, { kind: 'state', owner: 'T3 Code', dir: 'project/.git/refs/t3' }],
    ['project/.git/refs/t3', 'dir', { kind: 'state', owner: 'T3 Code', dir: 'project/.git/refs/t3' }],
    ['project/.git/refs/t3x', 'dir', undefined],
    ['project/.git/refs/t3/teamai/r1', sha, undefined],
    // What sbx v0.51.0 and v0.53.0 write on macOS in the HOME an `sbx ls` or `sbx template ls` is asked from while it is
    // not signed in there.
    [`${SBX}/sandboxes/analyticskit/events/default/anonymous/sandboxes~1~0.marlin.v1.proto`, sha, { kind: 'state', owner: 'sbx', dir: SBX }],
    [`${SBX}/sandboxes/locks/dockerhub-refresh-77792493ac080e9d.lock`, sha, { kind: 'state', owner: 'sbx', dir: SBX }],
    [`${SBX}/sandboxes/auth-cooldown`, 'dir', { kind: 'state', owner: 'sbx', dir: SBX }],
    [`${SBX}/sandboxes/settings.json.lock`, sha, { kind: 'state', owner: 'sbx', dir: SBX }],
    [`${SBX}/sandboxes/sandboxd/client.log`, sha, { kind: 'state', owner: 'sbx', dir: SBX }],
    [`${SBX_CACHE}/sandboxes/policykit/governor.db`, sha, { kind: 'state', owner: 'sbx', dir: SBX_CACHE }],
    // What sbx v0.53.0 adds there for `sbx secret ls`, which teamai asks once `sbx ls` answers: its update check and its
    // feature toggles.
    [`${SBX}/sandboxes/sandboxd/update-state.json`, sha, { kind: 'state', owner: 'sbx', dir: SBX }],
    [`${SBX_CACHE}/sandboxes/unleash-toggles-production.json`, sha, { kind: 'state', owner: 'sbx', dir: SBX_CACHE }],
    // A folder that holds them is judged by what it holds.
    [`${SBX}/sandboxes/sandboxd`, 'dir', { kind: 'folder', owner: 'sbx' }],
    ['home/Library', 'dir', { kind: 'folder', owner: 'sbx' }],
    // Its image store holds the templates teamai saves (teamai-warm:<key>) and the disks of the sandboxes it makes.
    [`${SBX}/sandboxes/sandboxd/containerd`, 'dir', undefined],
    [`${SBX}/sandboxes/sandboxd/containerd/root/io.containerd.content.v1.content/blobs/sha256/${'a'.repeat(64)}`, sha, undefined],
    [`${SBX}/sandboxes/settings.json`, sha, undefined],
    ['home/Library/Preferences', 'dir', undefined],
    ['home/Library/Preferences/com.example.plist', sha, undefined],
    // OpenCode's own folders under the XDG folders of a HOME that sets none, as v2.3.0 fills them: on any start,
    // `opencode --version` included, and in a session a step opens (its database, shell and snapshot folders).
    ['home/.cache/opencode/bin', 'dir', { kind: 'state', owner: 'OpenCode', dir: 'home/.cache/opencode' }],
    ['home/.local/share/opencode/log/opencode.log', sha, { kind: 'state', owner: 'OpenCode', dir: 'home/.local/share/opencode' }],
    ['home/.local/share/opencode/repos', 'dir', { kind: 'state', owner: 'OpenCode', dir: 'home/.local/share/opencode' }],
    ['home/.local/share/opencode/opencode.db', sha, { kind: 'state', owner: 'OpenCode', dir: 'home/.local/share/opencode' }],
    ['home/.local/share/opencode/snapshot/cb253d22366577419c7461916f9a348b44041300', 'dir', { kind: 'state', owner: 'OpenCode', dir: 'home/.local/share/opencode' }],
    ['home/.local/state/opencode', 'dir', { kind: 'state', owner: 'OpenCode', dir: 'home/.local/state/opencode' }],
    ['home/.local/state/opencode/prompt-history.jsonl', sha, { kind: 'state', owner: 'OpenCode', dir: 'home/.local/state/opencode' }],
    // The folders that hold them are judged by what they hold.
    ['home/.cache', 'dir', { kind: 'folder', owner: 'OpenCode' }],
    ['home/.local/share', 'dir', { kind: 'folder', owner: 'OpenCode' }],
    ['home/.local', 'dir', { kind: 'folder', owner: 'OpenCode' }],
    // Nothing beyond OpenCode's own folders: not what its TUI keeps elsewhere, nor another program's beside them.
    ['home/.local/share/opentui/tree-sitter', 'dir', undefined],
    ['home/Library/Caches/bun', 'dir', undefined],
    ['home/.local/share/opencode-other/x.log', sha, undefined],
    ['home/.local/bin', 'dir', undefined],
    ['home/.cache/teamai/opencode/log/x.log', sha, undefined],
    ['home/.local/share/opencode/teamai-hooks.ts', sha, undefined],
  ])('judges %s holding %s as the state of %o', (entry, value, own) => {
    expect(ledgerRules([]).ownStateOf(entry, value)).toEqual(own);
  });
});

describe("a tool instance's home in a ledger's section (e)", () => {
  /**
   * A HOME whose workspace install's team repo declares acme-claude, with a command of its own, and beta-claude, on
   * Claude's, and whose member declares their own nested one.
   */
  function homeWithInstances(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-inst-'));
    roots.push(home);
    const dataHome = path.join(home, '.teamai', 'projects', 'w-project-0123456789abcdef');
    const team = path.join(dataHome, 'team-repo');
    fs.mkdirSync(path.join(team, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(team, 'tools', 'acme-claude.yaml'), 'schemaVersion: v1alpha1\nname: acme-claude\nextends: claude\ncommand: acme-claude\nhome: { dir: .acme-claude, env: ACME_CLAUDE_CONFIG_DIR }\n');
    fs.writeFileSync(path.join(dataHome, 'config.yaml'), `repo:\n  localPath: ${team}\n  remote: https://teamai.test/team/repo.git\nscope: workspace\nenabledAgents:\n  - claude\n  - acme-claude\n`);
    // A home written with a leading ./ and a trailing / is the same folder.
    fs.writeFileSync(path.join(team, 'tools', 'beta-claude.yaml'), 'schemaVersion: v1alpha1\nname: beta-claude\nextends: claude\nhome: { dir: ./.beta/ }\n');
    fs.mkdirSync(path.join(home, '.teamai', 'tools', 'own-codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.teamai', 'tools', 'own-codex', 'TOOL.yaml'), 'schemaVersion: v1alpha1\nname: own-codex\nextends: codex\nhome: { dir: .own/codex }\n');

    return home;
  }

  it('reads every instance the install declares, with its home as teamai joins it to HOME', async () => {
    const instances = await toolInstancesIn(homeWithInstances());

    expect(instances.map((instance) => [instance.name, instance.home?.dir]).sort()).toEqual([['acme-claude', '.acme-claude'], ['beta-claude', '.beta'], ['own-codex', '.own/codex']]);
  });

  const sha = 'f'.repeat(64);

  // What a step run as acme-claude leaves in its home after uninstall, judged as Claude's own home is.
  it.each([
    ['home/.acme-claude/projects/-w-project/s.jsonl', sha, { kind: 'state', owner: 'the tool', dir: 'home/.acme-claude' }],
    ['home/.acme-claude/projects', 'dir', { kind: 'state', owner: 'the tool', dir: 'home/.acme-claude' }],
    ['home/.own/codex/sessions/2026/11/13/rollout.jsonl', sha, { kind: 'state', owner: 'the tool', dir: 'home/.own/codex' }],
    // What teamai writes there, where Claude reads it in its own home: never the tool's.
    ['home/.acme-claude/settings.json', sha, undefined],
    ['home/.acme-claude/skills/hello-world/SKILL.md', sha, undefined],
    ['home/.acme-claude/.claude.json', sha, undefined],
    ['home/.acme-claude/teamai-hooks.json', sha, undefined],
  ])('judges %s holding %s in an instance home as the state of %o', async (entry, value, own) => {
    const rules = ledgerRules(await toolInstancesIn(homeWithInstances()));

    expect(rules.ownStateOf(entry, value)).toEqual(own);
  });

  it("keeps an instance's home and its project folder as it keeps its tool's, and its state file as the tool's own while it holds no server", async () => {
    const rules = ledgerRules(await toolInstancesIn(homeWithInstances()));

    expect(['home/.acme-claude', 'home/.own', 'home/.own/codex', 'project/.acme-claude', 'home/.claude'].map((entry) => rules.knownLeftover(entry))).toEqual(['dir', 'dir', 'dir', 'dir', 'dir']);
    // An instance on Claude's own command keeps Claude's project paths, so no project folder is its own.
    expect(rules.knownLeftover('project/.beta')).toBeUndefined();
    expect(rules.isToolOwnState('home/.acme-claude/.claude.json', '{"numStartups":1}')).toBe(true);
    expect(rules.isToolOwnState('home/.acme-claude/.claude.json', '{"mcpServers":{"docs":{"command":"node"}}}')).toBe(false);
  });

  it('keeps what teamai delivers to the paths an instance sets for itself a LEAK, as its tool\'s', async () => {
    const home = homeWithInstances();
    const team = path.join(home, '.teamai', 'projects', 'w-project-0123456789abcdef', 'team-repo');
    fs.writeFileSync(path.join(team, 'tools', 'acme-claude.yaml'), 'schemaVersion: v1alpha1\nname: acme-claude\nextends: claude\nhome: { dir: .acme-claude }\npaths: { skills: .acme-claude/skills, settings: .acme-claude/settings.json, mcp: .acme-claude/.claude.json, userScope: { rules: .acme-claude/team-rules } }\n');
    const rules = ledgerRules(await toolInstancesIn(home));

    expect(['home/.acme-claude/skills/hello-world/SKILL.md', 'home/.acme-claude/settings.json', 'home/.acme-claude/.claude.json', 'home/.acme-claude/team-rules/style.md'].map((entry) => rules.ownStateOf(entry, sha))).toEqual([undefined, undefined, undefined, undefined]);
    expect(rules.ownStateOf('home/.acme-claude/projects/-w-project/s.jsonl', sha)).toEqual({ kind: 'state', owner: 'the tool', dir: 'home/.acme-claude' });
  });

  it("reads a member's own instance in place of the team's of the same name", async () => {
    const home = homeWithInstances();
    fs.writeFileSync(path.join(home, '.teamai', 'tools', 'acme-claude.yaml'), 'schemaVersion: v1alpha1\nname: acme-claude\nextends: claude\nhome: { dir: .mine }\n');

    expect((await toolInstancesIn(home)).filter((instance) => instance.name === 'acme-claude').map((instance) => instance.home?.dir)).toEqual(['.mine']);
  });

  it("reads a workspace's team instance in place of the user scope's of the same name, as teamai does", async () => {
    const home = homeWithInstances();
    const userTeam = path.join(home, '.teamai', 'team-repo');
    fs.mkdirSync(path.join(userTeam, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(userTeam, 'tools', 'acme-claude.yaml'), 'schemaVersion: v1alpha1\nname: acme-claude\nextends: claude\nhome: { dir: .user-acme }\n');
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), `repo:\n  localPath: ${userTeam}\n  remote: https://teamai.test/team/user.git\nscope: user\n`);

    expect((await toolInstancesIn(home)).filter((instance) => instance.name === 'acme-claude').map((instance) => instance.home?.dir)).toEqual(['.acme-claude']);
  });

  it('excuses nothing in the home of an instance it could not read', () => {
    const rules = ledgerRules([]);

    expect(rules.knownLeftover('home/.acme-claude')).toBeUndefined();
    expect(rules.ownStateOf('home/.acme-claude/projects/-w-project/s.jsonl', sha)).toBeUndefined();
    expect(rules.isToolOwnState('home/.acme-claude/.claude.json', '{"numStartups":1}')).toBe(false);
  });
});

describe('the homes on this machine the ledger reads for files that name a world', () => {
  const instance = { kind: 'instance', name: 'acme-codex', extends: 'codex', home: { dir: '.acme-codex', env: 'ACME_CODEX_HOME' }, source: 'team', file: 'f', location: 'l', revision: 'r' } as const;

  it("leaves out an instance home this shell's variable moves into the world itself, which is the world's own", () => {
    const world = { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-world-')) };
    roots.push(world.dir);
    vi.stubEnv('ACME_CODEX_HOME', path.join(world.dir, 'home', 'work', 'acme-moved'));

    try {
      expect(hostHomes(world, [instance]).filter((home) => home.startsWith(world.dir))).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reads an instance home this shell moves elsewhere on the machine', () => {
    const world = { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-world-')) };
    roots.push(world.dir);
    const elsewhere = path.join(os.tmpdir(), 'ledger-acme-elsewhere');
    vi.stubEnv('ACME_CODEX_HOME', elsewhere);

    try {
      expect(hostHomes(world, [instance])).toContain(elsewhere);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("a file section (e) reads after the walk listed it", () => {
  const sha = (c: string) => c.repeat(64);

  const placeIn = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-gone-'));
    roots.push(root);
    const place = { home: path.join(root, 'home'), project: path.join(root, 'project') };
    fs.mkdirSync(path.join(place.project, '.git', 'info'), { recursive: true });
    fs.mkdirSync(place.home);

    return place;
  };

  // A tool still running, such as Codex removing a lock file, can remove a file between the walk and the read.
  it.each<{ file: string; entry: string; before: Record<string, string>; writers: Record<string, { program: string; value: string }>; tracked: string[]; leaks: string[] }>([
    { file: 'a file teamai shares with a tool, left as the tool wrote it', entry: 'project/.git/info/exclude', before: {}, writers: { 'project/.git/info/exclude': { program: 'git', value: sha('a') } }, tracked: [], leaks: [] },
    { file: "a file left behind, read for a tool's own state", entry: 'home/.claude.json', before: {}, writers: {}, tracked: [], leaks: [] },
    { file: 'a file the repository tracks, changed and not committed', entry: 'project/notes.md', before: { 'project/notes.md': sha('d') }, writers: {}, tracked: ['notes.md'], leaks: ['project/notes.md removed'] },
  ])('judges $file, removed since the walk listed it, as not there', ({ entry, before, writers, tracked, leaks }) => {
    const place = placeIn();

    expect(uninstallChanges({ place, before, after: { [entry]: sha('a') }, writers, repository: { tracked, dirty: tracked }, rules: ledgerRules([]) })).toEqual({ leaks, notes: [] });
  });

  it('still fails on a read error other than a file that is gone', () => {
    const place = placeIn();
    fs.mkdirSync(path.join(place.home, '.claude.json'));

    expect(() => uninstallChanges({ place, before: {}, after: { 'home/.claude.json': sha('b') }, writers: {}, repository: { tracked: [], dirty: [] }, rules: ledgerRules([]) })).toThrow(/EISDIR/);
  });
});

describe("the empty [hooks.state] table Codex leaves in its config.toml, in a ledger's section (e)", () => {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const own = 'cli_auth_credentials_store = "file"\n';
  const ACME = { kind: 'instance' as const, name: 'acme-codex', extends: 'codex' as const, home: { dir: 'work/acme-moved' }, source: 'team' as const, file: '/team/tools/acme-codex.yaml', location: 'tools/acme-codex.yaml', revision: 'r1' };
  const rules = ledgerRules([ACME], [{ tool: 'codex', home: '.codex-work' }]);

  const judge = (entry: string, text: string, earlier: { before?: string; wrote?: string }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-hooks-state-'));
    roots.push(root);
    const place = { home: path.join(root, 'home'), project: path.join(root, 'project') };
    const file = path.join(root, entry);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    const before = earlier.before === undefined ? {} : { [entry]: hash(earlier.before) };
    const writers = earlier.wrote === undefined ? {} : { [entry]: { program: 'cp', value: hash(earlier.wrote) } };

    return uninstallChanges({ place, before, after: { [entry]: hash(text) }, writers, repository: { tracked: [], dirty: [] }, rules });
  };

  it.each([
    { home: "Codex's own home, beside what it held before", entry: 'home/.codex/config.toml', earlier: { before: own } },
    { home: 'the Codex root init recorded through toolRoots, beside what a member program wrote', entry: 'home/.codex-work/config.toml', earlier: { wrote: own } },
    { home: "a Codex instance's home its variable moved, beside what a member program wrote", entry: 'home/work/acme-moved/config.toml', earlier: { wrote: own } },
  ])("attributes it to Codex in $home", ({ entry, earlier }) => {
    const judged = judge(entry, `${own}\n[hooks.state]\n`, earlier);

    expect(judged.leaks).toEqual([]);
    expect(judged.notes).toEqual([expect.stringMatching(new RegExp(`^Codex's empty \\[hooks\\.state\\] table.*: ${entry.replaceAll('.', '\\.')}$`))]);
  });

  it.each([
    { left: "a trust entry of teamai's", text: `${own}\n[hooks.state]\n\n[hooks.state."/w/home/.codex-work/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:00"\n` },
    { left: 'a line no one the ledger knows wrote', text: `${own}model = "o3"\n\n[hooks.state]\n` },
  ])('keeps the file a LEAK when it holds $left beside the table', ({ text }) => {
    expect(judge('home/.codex-work/config.toml', text, { wrote: own }).leaks).toEqual(['home/.codex-work/config.toml left behind']);
  });
});
