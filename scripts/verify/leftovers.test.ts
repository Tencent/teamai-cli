import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signalChild } from '@teamai/shared/process-group';
import { attributeLeftover, cleanupPlan, linesOf, planCleanup, probeHere, removeLeftover, worldTier, type WorldTies } from './leftovers.js';
import type { World } from './world.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();

  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const SELF: WorldTies = { runId: '20261112T120000-aaaaaa', paths: ['/w/20261112T120000-aaaaaa', '/private/tmp/teamai-verify-20261112T120000-aaaaaa'], journals: ['0123456789abcdef'], runs: ['r00000000000000aa'] };
const OTHER: WorldTies = { runId: '20261112T110000-bbbbbb', paths: ['/w/20261112T110000-bbbbbb'], journals: ['fedcba9876543210'], runs: ['r00000000000000bb'] };

describe('whose leftover it is', () => {
  it("is this world's when it names a path inside it, its TMPDIR included, or a journal or run of its own", () => {
    expect(attributeLeftover({ paths: ['/w/20261112T120000-aaaaaa/home/x'], journals: [], runs: [], marked: false }, SELF, [OTHER]).kind).toBe('own');
    expect(attributeLeftover({ paths: ['/private/tmp/teamai-verify-20261112T120000-aaaaaa'], journals: [], runs: [], marked: false }, SELF, [OTHER]).kind).toBe('own');
    expect(attributeLeftover({ paths: [], journals: ['0123456789abcdef'], runs: [], marked: true }, SELF, [OTHER]).kind).toBe('own');
    expect(attributeLeftover({ paths: [], journals: [], runs: ['r00000000000000aa'], marked: true }, SELF, [OTHER]).kind).toBe('own');
  });

  it("is another world's when it is tied to that one only, and never this world's leak", () => {
    expect(attributeLeftover({ paths: ['/w/20261112T110000-bbbbbb/project'], journals: [], runs: [], marked: false }, SELF, [OTHER])).toEqual({ kind: 'other_world', runId: OTHER.runId });
    expect(attributeLeftover({ paths: [], journals: ['fedcba9876543210'], runs: [], marked: true }, SELF, [OTHER])).toEqual({ kind: 'other_world', runId: OTHER.runId });
  });

  it('does not take a path that only starts like a world path for one inside it', () => {
    expect(attributeLeftover({ paths: ['/w/20261112T120000-aaaaaa-copy/x'], journals: [], runs: [], marked: false }, SELF, []).kind).toBe('unrelated');
  });

  it("is ambiguous when it carries teamai's mark but no world's tie, and unrelated when it carries neither", () => {
    expect(attributeLeftover({ paths: ['/Users/me/repo'], journals: ['1111111111111111'], runs: [], marked: true }, SELF, [OTHER]).kind).toBe('ambiguous');
    expect(attributeLeftover({ paths: ['/Users/me/repo'], journals: [], runs: [], marked: false }, SELF, [OTHER])).toEqual({ kind: 'unrelated' });
  });
});

describe("a world's tier", () => {
  it('is basic when no step runtime left a record, middle when only teamai\'s own process ran steps, and driver once a runtime outside it, a sandbox journal or a container member exists', () => {
    expect(worldTier({ inProcessRecords: 0, externalRecords: 0, runtimeJournals: 0, containerMembers: 0 })).toBe('basic');
    expect(worldTier({ inProcessRecords: 2, externalRecords: 0, runtimeJournals: 0, containerMembers: 0 })).toBe('middle');
    expect(worldTier({ inProcessRecords: 2, externalRecords: 1, runtimeJournals: 0, containerMembers: 0 })).toBe('driver');
    expect(worldTier({ inProcessRecords: 0, externalRecords: 0, runtimeJournals: 1, containerMembers: 0 })).toBe('driver');
    expect(worldTier({ inProcessRecords: 0, externalRecords: 0, runtimeJournals: 0, containerMembers: 1 })).toBe('driver');
    // After uninstall took the records away, a world a runtime outside teamai's process ran in keeps every check.
    expect(worldTier({ inProcessRecords: 0, externalRecords: 0, runtimeJournals: 0, containerMembers: 0, driverSeen: true })).toBe('driver');
  });
});

describe('what each row reads from what an engine or the process table printed', () => {
  it("takes a process's working directory and the absolute paths its arguments name, and skips the harness's own chain", async () => {
    const { lineageOf, parseLsofCwd, parseProcLines, parsePs, pathsNamed } = await import('./leftovers/processes.js');
    const procs = parsePs('    1     0 /sbin/launchd\n  500     1 node /w/x/bin/teamai workflow serve\n  600   500 /bin/sh -c sleep 1000 --dir=/w/20261112T120000-aaaaaa/home\n');

    expect(procs.map((proc) => proc.pid)).toEqual([1, 500, 600]);
    expect(pathsNamed(procs[2]?.command ?? '')).toEqual(['/bin/sh', '/w/20261112T120000-aaaaaa/home']);
    expect(parseLsofCwd('p500\nfcwd\nn/w/20261112T120000-aaaaaa/project\np600\nfcwd\nn/\n')).toEqual(new Map([[500, '/w/20261112T120000-aaaaaa/project'], [600, '/']]));
    expect([...lineageOf(600, procs)]).toEqual([600, 500]);
    expect(parseProcLines('42\t1\t/w/20261112T120000-aaaaaa/project\tnode /x a b\nnot a line\n')).toEqual([{ pid: 42, ppid: 1, cwd: '/w/20261112T120000-aaaaaa/project', command: 'node /x a b' }]);
  });

  it('says it could not see every working directory on macOS when lsof ends without success or with a note, whatever it listed before', async () => {
    const { readDarwinTable } = await import('./leftovers/processes.js');
    const ps = '  500     1 node /w/x/bin/teamai\n  600     1 sleep 900\n';
    const listed = (lsof: { code: number | null; stdout: string; why: string }) => readDarwinTable({ label: 'this machine', ps, lsof });

    expect(listed({ code: 0, stdout: 'p500\nfcwd\nn/w\np600\nfcwd\nn/\n', why: '' }).unseen).toEqual([]);
    expect(listed({ code: 1, stdout: 'p500\nfcwd\nn/w\n', why: 'lsof: WARNING: can\'t stat() a file system' }).unseen).toEqual([
      { kind: 'not_observed', what: 'working directories on this machine', why: "lsof ended with 1 after listing 1 (lsof: WARNING: can't stat() a file system), so a process it missed may be the world's" },
    ]);
    expect(listed({ code: null, stdout: 'p500\nfcwd\nn/w\n', why: 'spawnSync lsof ETIMEDOUT' }).unseen).toEqual([
      { kind: 'not_observed', what: 'working directories on this machine', why: "lsof ended with no exit code after listing 1 (spawnSync lsof ETIMEDOUT), so a process it missed may be the world's" },
    ]);
    expect(listed({ code: 0, stdout: 'p500\nfcwd\nn/w\n', why: 'lsof: no pwd entry for UID 501' }).unseen).toEqual([
      { kind: 'not_observed', what: 'working directories on this machine', why: "lsof listed 1 but said lsof: no pwd entry for UID 501, so a process it missed may be the world's" },
    ]);
    expect(listed({ code: 0, stdout: '', why: '' }).unseen).toEqual([{ kind: 'not_observed', what: 'working directories on this machine', why: 'lsof listed none ()' }]);
    expect(listed({ code: 0, stdout: 'p500\nfcwd\nn/w\n', why: '' }).procs.map((proc) => proc.cwd)).toEqual(['/w', undefined]);
  });

  it('reads containers with their owner, run and mounts', async () => {
    const { parseContainers, parseMounts } = await import('./leftovers/containers.js');

    expect(parseContainers('abc123\tteamai-r1-a1\t0123456789abcdef\tr1\trunning\n')).toEqual([{ id: 'abc123', name: 'teamai-r1-a1', owner: '0123456789abcdef', run: 'r1', state: 'running' }]);
    expect(parseMounts('abc123abc123ffff\t/w/20261112T120000-aaaaaa/project\t/tmp/x\n')).toEqual(new Map([['abc123abc123', ['/w/20261112T120000-aaaaaa/project', '/tmp/x']]]));
  });
});

/** An image the fake engine keeps: its full id (hex), its tags (`<repo>:<none>` for one only a digest names), and its labels. */
interface FakeImage {
  readonly id: string;
  readonly tags: string[];
  readonly labels: Record<string, string>;
  /** Removed by someone else right after an `image ls` listed it. */
  readonly goesAfterListing?: boolean;
}

/** A network the fake engine keeps: its id, name and labels. */
interface FakeNetwork {
  readonly id: string;
  readonly name: string;
  readonly labels: Record<string, string>;
}

/**
 * A container engine that answers `info`, `ps`, `network ls`, `image ls`, `image inspect` and `image rm`. As docker it
 * answers as Docker 29.4.3 does: its `image ls` template has no `.Label`/`.Labels` (it fails on the first row, as the real
 * one printed `can't evaluate field Label in type *formatter.imageContext`), its `network ls` has `.Label`, its `image
 * inspect` gives `.Id` as `sha256:<hex>`, and it refuses to remove by id an image that more than one tag names. As podman
 * it answers as podman's docs say: `network ls` has `.Labels`, a map, and no `.Label`; `image inspect` gives `.Id` as hex.
 */
function fakeEngine({ dir, engine = 'docker', images, networks = [] }: { dir: string; engine?: 'docker' | 'podman'; images: readonly FakeImage[]; networks?: readonly FakeNetwork[] }): { bin: string; images: () => FakeImage[] } {
  const bin = path.join(dir, 'bin');
  const state = path.join(dir, 'images.json');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(state, JSON.stringify(images));
  fs.writeFileSync(path.join(bin, engine), `#!${process.execPath}
const fs = require('node:fs');
const engine = ${JSON.stringify(engine)};
const networks = ${JSON.stringify(networks)};
const state = ${JSON.stringify(state)};
const images = JSON.parse(fs.readFileSync(state, 'utf8'));
const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1]; };
const render = (template, fields, context) => template.replace(/{{\\s*(.*?)\\s*}}/g, (whole, key) => {
  if (key in fields) return fields[key];
  process.stderr.write('template parsing error: template: :1:' + (template.indexOf(whole) + 2) + ': executing "" at <' + key.split(' ')[0] + '>: can\\'t evaluate field ' + key.split(' ')[0].slice(1) + ' in type *formatter.' + context + '\\n');
  process.exit(1);
});
const find = (ref) => images.find((image) => image.tags.includes(ref) || image.tags.includes(ref + ':latest') || ('sha256:' + image.id).startsWith(ref) || (ref.length >= 12 && image.id.startsWith(ref)));
const [verb, sub] = args;
if (verb === 'info') { process.stdout.write(engine === 'docker' ? '29.4.3\\n' : '5.4.0\\n'); process.exit(0); }
if (verb === 'ps') process.exit(0);
if (verb === 'network' && sub === 'ls') {
  const label = (option('--filter') ?? '').replace(/^label=/, '');
  for (const network of networks.filter((one) => label in one.labels)) {
    const owner = network.labels['teamai.owner'] ?? '';
    process.stdout.write(render(option('--format'), engine === 'docker' ? { '.ID': network.id, '.Name': network.name, '.Label "teamai.owner"': owner } : { '.ID': network.id, '.Name': network.name, 'index .Labels "teamai.owner"': owner }, 'networkContext') + '\\n');
  }
  process.exit(0);
}
if (verb !== 'image') process.exit(1);
if (sub === 'ls') {
  const label = (option('--filter') ?? '').replace(/^label=/, '');
  for (const image of images.filter((one) => label === '' || label in one.labels)) {
    for (const name of image.tags.length === 0 ? ['<none>:<none>'] : image.tags) {
      const [repository, tag] = name.split(':');
      process.stdout.write(render(option('--format'), { '.ID': image.id.slice(0, 12), '.Repository': repository, '.Tag': tag }, 'imageContext') + '\\n');
    }
  }
  fs.writeFileSync(state, JSON.stringify(images.filter((one) => one.goesAfterListing !== true)));
  process.exit(0);
}
if (sub === 'inspect') {
  let code = 0;
  for (const ref of args.slice(4)) {
    const image = find(ref);
    if (image === undefined) { process.stderr.write('Error response from daemon: No such image: ' + ref + '\\n'); code = 1; continue; }
    process.stdout.write(render(option('--format'), { '.Id': (engine === 'docker' ? 'sha256:' : '') + image.id, 'index .Config.Labels "teamai.owner"': image.labels['teamai.owner'] ?? '' }, 'imageInspect') + '\\n');
  }
  process.exit(code);
}
if (sub === 'rm') {
  const ref = args[2];
  if (ref.includes('<none>')) { process.stderr.write('Error response from daemon: invalid reference format\\n'); process.exit(1); }
  const image = find(ref);
  if (image === undefined) { process.stderr.write('Error response from daemon: No such image: ' + ref + '\\n'); process.exit(1); }
  if (image.tags.includes(ref)) image.tags.splice(image.tags.indexOf(ref), 1);
  else if (image.tags.length > 1) { process.stderr.write('Error response from daemon: conflict: unable to delete ' + ref + ' (must be forced) - image is referenced in multiple repositories\\n'); process.exit(1); }
  else image.tags.length = 0;
  fs.writeFileSync(state, JSON.stringify(image.tags.length === 0 ? images.filter((one) => one !== image) : images));
  process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });

  return { bin, images: () => JSON.parse(fs.readFileSync(state, 'utf8')) as FakeImage[] };
}

describe("the container engines' row of section (f)", () => {
  async function observeContainers(images: readonly FakeImage[], { engine: name = 'docker', networks = [] }: { engine?: 'docker' | 'podman'; networks?: readonly FakeNetwork[] } = {}) {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-verify-engine-')));
    roots.push(dir);
    const engine = fakeEngine({ dir, engine: name, images, networks });
    // The fake docker alone: a podman of the host, as CI runners have in /usr/bin, would answer for its own state.
    vi.stubEnv('PATH', engine.bin);
    const world: World = {
      runId: SELF.runId, dir, project: `${dir}/project`, team: `${dir}/team.git`, home: `${dir}/home`, tmp: `${dir}/tmp`, logs: `${dir}/logs`, bin: engine.bin,
      build: { commit: 'c', dirty: false, version: '0.0.0', tarball: 't.tgz', sha256: 's', node: 'v20' },
      createdAt: '2026-11-12T18:00:00.000Z',
      baseline: { teamRefs: {}, checkoutStatus: [] },
    };
    const { containers } = await import('./leftovers/containers.js');

    return { engine, observed: await containers.observe({ world, self: SELF, others: [OTHER], records: { files: [], runs: [], runtimeJournals: 0, placements: [] } }) };
  }

  it("lists on Docker 29 the images teamai labelled, each tied to the world whose journal owns it, and asks the engine nothing it cannot answer", async () => {
    const { observed } = await observeContainers([
      { id: 'a'.repeat(64), tags: ['teamai-warm:kmine'], labels: { 'teamai.owner': SELF.journals[0] ?? '' } },
      { id: 'b'.repeat(64), tags: ['teamai-warm:ktheirs'], labels: { 'teamai.owner': OTHER.journals[0] ?? '' } },
      { id: 'c'.repeat(64), tags: ['node:22-alpine'], labels: {} },
    ]);

    expect(observed.filter((seen) => seen.kind === 'not_observed')).toEqual([]);
    expect(observed.flatMap((seen) => (seen.kind === 'observed' ? seen.findings : [])).map((finding) => [finding.what, finding.attribution.kind])).toEqual([
      ['docker image teamai-warm:kmine', 'own'],
      ['docker image teamai-warm:ktheirs', 'other_world'],
    ]);
  });

  it.each(['docker', 'podman'] as const)("lists on %s the networks and images teamai labelled with the template that engine answers", async (engine) => {
    const owner = { 'teamai.owner': SELF.journals[0] ?? '' };
    const { observed } = await observeContainers([{ id: 'a'.repeat(64), tags: ['teamai-warm:kmine'], labels: owner }], { engine, networks: [{ id: 'n0123abcd', name: 'teamai-r1-a1-net', labels: owner }] });

    expect(observed.filter((seen) => seen.kind === 'not_observed')).toEqual([]);
    expect(observed.flatMap((seen) => (seen.kind === 'observed' ? seen.findings : [])).map((finding) => [finding.what, finding.attribution.kind])).toEqual([
      [`${engine} network teamai-r1-a1-net`, 'own'],
      [`${engine} image teamai-warm:kmine`, 'own'],
    ]);
  });

  it("lists the world's images when another one goes between the listing and the look at its owner", async () => {
    const { observed } = await observeContainers([
      { id: 'a'.repeat(64), tags: ['teamai-warm:kmine'], labels: { 'teamai.owner': SELF.journals[0] ?? '' } },
      { id: 'b'.repeat(64), tags: ['teamai-warm:ktheirs'], labels: { 'teamai.owner': OTHER.journals[0] ?? '' }, goesAfterListing: true },
    ]);

    expect(observed.filter((seen) => seen.kind === 'not_observed')).toEqual([]);
    expect(observed.flatMap((seen) => (seen.kind === 'observed' ? seen.findings : [])).map((finding) => [finding.what, finding.attribution.kind])).toEqual([
      ['docker image teamai-warm:kmine', 'own'],
    ]);
  });

  it('removes on cleanup an image of the world that its repository names with no tag, by its id', async () => {
    const { engine, observed } = await observeContainers([{ id: 'a'.repeat(64), tags: ['teamai-warm:<none>'], labels: { 'teamai.owner': SELF.journals[0] ?? '' } }]);
    const findings = observed.flatMap((seen) => (seen.kind === 'observed' ? seen.findings : []));

    expect(findings.map((finding) => [finding.what, finding.attribution.kind])).toEqual([['docker image teamai-warm:<none>', 'own']]);
    expect(findings.map((finding) => removeLeftover({ command: finding.remove ?? [] }))).toEqual([{ ok: true, wasThere: true }]);
    expect(engine.images()).toEqual([]);
  });

  it('removes on cleanup an image of the world that two tags name, one name at a time, where removal by id is refused', async () => {
    const { engine, observed } = await observeContainers([
      { id: 'a'.repeat(64), tags: ['teamai-warm:kmine', 'teamai-warm:kalias'], labels: { 'teamai.owner': SELF.journals[0] ?? '' } },
      { id: 'c'.repeat(64), tags: ['node:22-alpine'], labels: {} },
    ]);
    const findings = observed.flatMap((seen) => (seen.kind === 'observed' ? seen.findings : []));

    expect(findings.map((finding) => [finding.what, finding.attribution.kind])).toEqual([
      ['docker image teamai-warm:kmine', 'own'],
      ['docker image teamai-warm:kalias', 'own'],
    ]);
    expect(findings.map((finding) => removeLeftover({ command: finding.remove ?? [] }))).toEqual([{ ok: true, wasThere: true }, { ok: true, wasThere: true }]);
    expect(engine.images().map((image) => image.tags)).toEqual([['node:22-alpine']]);
  });

  it('counts in the ledger only what is left once teamai uninstall ran, not the warm image uninstall removes', async () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-verify-engine-')));
    roots.push(dir);
    const [{ journal }, { sandboxJournalRoot }] = await Promise.all([import('../../packages/runtime-sandbox/src/journal.js'), import('../../packages/runtime-sandbox/src/journal-root.js')]);
    const owner = journal(sandboxJournalRoot(`${dir}/home`)).owner;
    const engine = fakeEngine({ dir, images: [{ id: 'a'.repeat(64), tags: ['teamai-warm:kmine'], labels: { 'teamai.owner': owner } }] });
    vi.stubEnv('PATH', `${engine.bin}:/usr/bin:/bin:/usr/sbin`);
    const world: World = {
      runId: SELF.runId, dir, project: `${dir}/project`, team: `${dir}/team.git`, home: `${dir}/home`, tmp: `${dir}/tmp`, logs: `${dir}/logs`, bin: engine.bin,
      build: { commit: 'c', dirty: false, version: '0.0.0', tarball: 't.tgz', sha256: 's', node: 'v20' },
      createdAt: '2026-11-12T18:00:00.000Z',
      baseline: { teamRefs: {}, checkoutStatus: [] },
      driverSeen: true,
    };
    const { leftoversSection } = await import('./leftovers.js');

    const section = await leftoversSection(world);
    // What uninstall does to the warm image it recorded making.
    expect(removeLeftover({ command: ['docker', 'image', 'rm', 'teamai-warm:kmine'] })).toEqual({ ok: true, wasThere: true });

    expect((await section.observe()).leaks).toEqual([]);
  });

  it("still says, once teamai uninstall removed the attempt records, that no observer read a closed sandbox's environment", async () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-verify-engine-')));
    roots.push(dir);
    const engine = fakeEngine({ dir, images: [] });
    vi.stubEnv('PATH', `${engine.bin}:/usr/bin:/bin:/usr/sbin`);
    // The record of a docker sandbox's attempt that closed before the observer looked, where teamai keeps it in user scope.
    const record = path.join(dir, 'home', '.teamai', 'workflows', 'runs', 'r0123abcd', 'attempts', 'a0123abcd', 'runtime.json');
    const origin = { layer: 'personal', location: 'drivers/box.yaml', revision: 'r' };
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, JSON.stringify({
      runtime: 'sandbox', driver: 'box', phase: 'closed', open: { op: 'op-0123abcd', handle: 'h' },
      sources: [{ runtime: 'teamai-sandbox', ...origin, sandbox: { profile: 'box', ...origin, location: 'sandboxes/box.yaml', provider: 'docker', enforces: {} } }],
    }));
    const world: World = {
      runId: SELF.runId, dir, project: `${dir}/project`, team: `${dir}/team.git`, home: `${dir}/home`, tmp: `${dir}/tmp`, logs: `${dir}/logs`, bin: engine.bin,
      build: { commit: 'c', dirty: false, version: '0.0.0', tarball: 't.tgz', sha256: 's', node: 'v20' },
      createdAt: '2026-11-12T18:00:00.000Z',
      baseline: { teamRefs: {}, checkoutStatus: [] },
      driverSeen: true,
    };
    const { leftoversSection } = await import('./leftovers.js');

    const section = await leftoversSection(world);
    // What uninstall does to the run records.
    fs.rmSync(path.join(dir, 'home', '.teamai'), { recursive: true });

    expect((await section.observe()).notes).toContain("NOT OBSERVED: run r0123abcd attempt a0123abcd's environment on docker, which no observer line read: its sandbox closed before the observer looked, or could not be read");
  });
});

describe("the sbx row of section (f)", () => {
  it("lists a world's sbx sandboxes in its own HOME, where sbx keeps them, and removes them there", async () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-verify-sbx-')));
    roots.push(dir);
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const name = `teamai-${SELF.journals[0]}-r0123abcd-a0123abcd`;
    // sbx keeps its sandboxes per HOME: only the world's HOME lists the world's sandbox, and only there does rm reach it.
    fs.writeFileSync(path.join(bin, 'sbx'), `#!/bin/sh\n[ "$HOME" = '${dir}/home' ] || { printf '[]'; exit 0; }\ncase "$1" in ls) printf '[{"name":"${name}"}]' ;; rm) printf '%s' "$3" > '${dir}/removed' ;; esac\n`, { mode: 0o755 });
    const world: World = {
      runId: SELF.runId, dir, project: `${dir}/project`, team: `${dir}/team.git`, home: `${dir}/home`, tmp: `${dir}/tmp`, logs: `${dir}/logs`, bin: `${dir}/bin`,
      build: { commit: 'c', dirty: false, version: '0.0.0', tarball: 't.tgz', sha256: 's', node: 'v20' },
      createdAt: '2026-11-12T18:00:00.000Z',
      baseline: { teamRefs: {}, checkoutStatus: [] },
      env: { HOME: `${dir}/home`, PATH: `${bin}:/usr/bin:/bin` },
    };
    const { sbxLeftovers } = await import('./leftovers/sbx.js');

    const [seen] = await sbxLeftovers.observe({ world, self: SELF, others: [], records: { files: [], runs: [], runtimeJournals: 0, placements: [] } });

    expect(seen?.kind === 'observed' ? seen.findings.map((finding) => [finding.what, finding.attribution.kind]) : seen).toEqual([[`sbx sandbox ${name}`, 'own']]);
    const [command = 'true', ...args] = (seen?.kind === 'observed' ? seen.findings[0]?.remove : undefined) ?? [];
    // As cleanup runs it: from the harness's own environment.
    expect(spawnSync(command, args).status).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'removed'), 'utf8')).toBe(name);
  });

  it("lists the warm templates teamai saved in a world's HOME, where sbx keeps its image store, and the kit templates sbx assembled there, and removes them there, one already gone too", async () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-verify-sbx-')));
    roots.push(dir);
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    // sbx's own template and one the member saved stay; teamai's warm template, `teamai-warm:<key>`, is teamai's, and the
    // kit template sbx 0.53.0 assembled in the world's HOME for the sandbox it was saved from holds the same image.
    const templates = JSON.stringify([
      { id: `sha256:${'a'.repeat(64)}`, repository: 'docker.io/docker/sandbox-templates', tag: 'claude-code-docker' },
      { id: `sha256:${'b'.repeat(64)}`, repository: 'docker.io/library/teamai-warm', tag: 'k0123abcd' },
      { id: `sha256:${'b'.repeat(64)}`, repository: 'docker.io/library/sandbox-kit-assembled', tag: '680a35427e6eced7' },
      { id: `sha256:${'c'.repeat(64)}`, repository: 'mine', tag: 'teamai-warm' },
    ]);
    // A second removal of one answers as sbx 0.53.0 does for a template that is gone.
    fs.writeFileSync(path.join(bin, 'sbx'), `#!/bin/sh\n[ "$HOME" = '${dir}/home' ] || { printf '[]'; exit 0; }\ncase "$1 $2" in 'ls --json') printf '[]' ;; 'template ls') printf '%s' '${templates}' ;; 'template rm') if grep -qxF "$4" '${dir}/removed' 2>/dev/null; then echo "error: cannot remove template \\"$4\\": delete template: image not found: request failed: 404 Not Found: no image \\"$4\\"" >&2; exit 1; fi; printf '%s\\n' "$4" >> '${dir}/removed' ;; *) exit 1 ;; esac\n`, { mode: 0o755 });
    // The world's sbx is the host's, as the world links it, so it answers from the HOME the world gives it.
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
    const world: World = {
      runId: SELF.runId, dir, project: `${dir}/project`, team: `${dir}/team.git`, home: `${dir}/home`, tmp: `${dir}/tmp`, logs: `${dir}/logs`, bin: `${dir}/bin`,
      build: { commit: 'c', dirty: false, version: '0.0.0', tarball: 't.tgz', sha256: 's', node: 'v20' },
      createdAt: '2026-11-12T18:00:00.000Z',
      baseline: { teamRefs: {}, checkoutStatus: [] },
      env: { HOME: `${dir}/home`, PATH: `${bin}:/usr/bin:/bin` },
    };
    const { sbxLeftovers } = await import('./leftovers/sbx.js');

    const observed = await sbxLeftovers.observe({ world, self: { ...SELF, paths: [dir] }, others: [], records: { files: [], runs: [], runtimeJournals: 0, placements: [] } });
    const findings = observed.flatMap((seen) => (seen.kind === 'observed' ? seen.findings : []));

    expect(observed.filter((seen) => seen.kind === 'not_observed')).toEqual([]);
    expect(findings.map((finding) => [finding.what, finding.attribution.kind])).toEqual([
      ['sbx template docker.io/library/teamai-warm:k0123abcd', 'own'],
      ["sbx template docker.io/library/sandbox-kit-assembled:680a35427e6eced7 (sbx's own, which teamai uninstall leaves)", 'own'],
    ]);

    // As cleanup runs it: from the harness's own environment, never asking before it removes.
    for (const finding of findings) expect(removeLeftover({ command: finding.remove ?? [], gone: finding.gone })).toEqual({ ok: true, wasThere: true });
    expect(fs.readFileSync(path.join(dir, 'removed'), 'utf8')).toBe('docker.io/library/teamai-warm:k0123abcd\ndocker.io/library/sandbox-kit-assembled:680a35427e6eced7\n');
    expect(removeLeftover({ command: findings[0]?.remove ?? [], gone: findings[0]?.gone })).toEqual({ ok: true, wasThere: false });
  });

  it("never takes the warm templates of the harness's HOME, where a world made before its env was kept is asked, for the world's", async () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-verify-sbx-')));
    const harnessHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-')));
    roots.push(dir, harnessHome);
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    // The maintainer's own sbx, in the harness's HOME, keeps a warm template teamai saved for them outside any world, and
    // a kit template sbx assembled for a sandbox of theirs, which is no teamai's.
    fs.writeFileSync(path.join(bin, 'sbx'), `#!/bin/sh\n[ "$HOME" = '${harnessHome}' ] || { printf '[]'; exit 0; }\ncase "$1 $2" in 'ls --json') printf '[]' ;; 'template ls') printf '[{"repository":"teamai-warm","tag":"kmine"},{"repository":"docker.io/library/sandbox-kit-assembled","tag":"2ba1c4db59226a62"}]' ;; *) exit 1 ;; esac\n`, { mode: 0o755 });
    vi.stubEnv('HOME', harnessHome);
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
    const world: World = {
      runId: SELF.runId, dir, project: `${dir}/project`, team: `${dir}/team.git`, home: `${dir}/home`, tmp: `${dir}/tmp`, logs: `${dir}/logs`, bin: `${dir}/bin`,
      build: { commit: 'c', dirty: false, version: '0.0.0', tarball: 't.tgz', sha256: 's', node: 'v20' },
      createdAt: '2026-11-12T18:00:00.000Z',
      baseline: { teamRefs: {}, checkoutStatus: [] },
    };
    const { sbxLeftovers } = await import('./leftovers/sbx.js');

    const observed = await sbxLeftovers.observe({ world, self: { ...SELF, paths: [dir] }, others: [], records: { files: [], runs: [], runtimeJournals: 0, placements: [] } });
    const findings = observed.flatMap((seen) => (seen.kind === 'observed' ? seen.findings : []));

    expect(findings.map((finding) => [finding.what, finding.attribution.kind])).toEqual([
      ['sbx template teamai-warm:kmine', 'ambiguous'],
      ["sbx template docker.io/library/sandbox-kit-assembled:2ba1c4db59226a62 (sbx's own, which teamai uninstall leaves)", 'unrelated'],
    ]);
  });

  it("takes no template for the world's, and removes none, when the world's sbx is not the host's, such as a shim that runs it in the person's HOME", async () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-verify-sbx-')));
    const personHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'person-home-')));
    roots.push(dir, personHome);
    const real = path.join(dir, 'real');
    const tools = path.join(dir, 'tools');
    fs.mkdirSync(real);
    fs.mkdirSync(tools);
    // The person's signed-in sbx keeps a kit template sbx assembled days before the world and a warm template their own
    // teamai saved. The world's tools/sbx was replaced by a shim that runs it in the person's HOME.
    fs.writeFileSync(path.join(real, 'sbx'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${dir}/calls'\n[ "$HOME" = '${personHome}' ] || { printf '[]'; exit 0; }\ncase "$1 $2" in 'ls --json') printf '[]' ;; 'template ls') printf '[{"repository":"docker.io/library/teamai-warm","tag":"kmine"},{"repository":"docker.io/library/sandbox-kit-assembled","tag":"2ba67192264a5ff7"}]' ;; *) exit 1 ;; esac\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(tools, 'sbx'), `#!/bin/sh\nHOME='${personHome}' exec '${real}/sbx' "$@"\n`, { mode: 0o755 });
    vi.stubEnv('HOME', personHome);
    vi.stubEnv('PATH', `${real}:/usr/bin:/bin`);
    const world: World = {
      runId: SELF.runId, dir, project: `${dir}/project`, team: `${dir}/team.git`, home: `${dir}/home`, tmp: `${dir}/tmp`, logs: `${dir}/logs`, bin: `${dir}/bin`,
      build: { commit: 'c', dirty: false, version: '0.0.0', tarball: 't.tgz', sha256: 's', node: 'v20' },
      createdAt: '2026-11-12T18:00:00.000Z',
      baseline: { teamRefs: {}, checkoutStatus: [] },
      env: { HOME: `${dir}/home`, PATH: `${tools}:/usr/bin:/bin` },
    };
    const { sbxLeftovers } = await import('./leftovers/sbx.js');

    const observed = await sbxLeftovers.observe({ world, self: { ...SELF, paths: [dir] }, others: [], records: { files: [], runs: [], runtimeJournals: 0, placements: [] } });

    expect(observed).toEqual([
      { kind: 'observed', findings: [], notes: [] },
      { kind: 'not_observed', what: 'sbx templates', why: `the install's PATH runs sbx as ${tools}/sbx, not as ${real}/sbx, the host's sbx a world links, so sbx may answer from a HOME that is not the install's (a shim that runs it with another HOME, say)` },
    ]);
    expect(cleanupPlan([{ onCleanup: sbxLeftovers.onCleanup, observed }])).toEqual({ kind: 'remove', removals: [], unobserved: [expect.stringMatching(/^sbx templates, /)] });
    // Sandboxes are still asked for: a sandbox's name carries the world's journal. Templates are never asked for there.
    expect(fs.readFileSync(path.join(dir, 'calls'), 'utf8')).toBe('ls --json\n');
  });
});

describe("a row's lines in section (f)", () => {
  const same = (text: string): string => text;

  it('says the row found none left even beside a note of its own, and never when part of it was not looked at', () => {
    expect(linesOf('open attempt place', [{ kind: 'observed', findings: [], notes: ['run r1 attempt a1 ran on seatbelt'] }], same)).toEqual({ leaks: [], notes: ['no open attempt place left', 'run r1 attempt a1 ran on seatbelt'] });
    expect(linesOf('teamai container', [{ kind: 'observed', findings: [], notes: [] }, { kind: 'observed', findings: [], notes: ['podman: not installed here'] }], same)).toEqual({ leaks: [], notes: ['no teamai container left', 'podman: not installed here'] });
    expect(linesOf('teamai container', [{ kind: 'observed', findings: [], notes: [] }, { kind: 'not_observed', what: 'podman containers', why: 'podman info failed' }], same)).toEqual({ leaks: [], notes: ['NOT OBSERVED: podman containers, podman info failed'] });
    expect(linesOf('teamai container', [{ kind: 'observed', findings: [{ what: 'docker container c', attribution: { kind: 'ambiguous', why: 'tied to no world' } }], notes: [] }], same)).toEqual({ leaks: [], notes: ['docker container c: tied to no world, so not counted here'] });
  });

  it('masks every line it writes, a NOT OBSERVED one and a note of the row too', () => {
    const mask = (text: string): string => text.replaceAll('s3cret-value', '<REDACTED:KEY>');

    expect(linesOf('world process', [
      { kind: 'not_observed', what: 'working directories', why: 'lsof said s3cret-value' },
      { kind: 'observed', findings: [], notes: ['process 42 ran with s3cret-value'] },
    ], mask).notes.join('\n')).not.toContain('s3cret-value');
  });
});

describe('what cleanup does with what the rows found', () => {
  const own = { kind: 'own', why: 'names the world' } as const;
  const theirs = { kind: 'other_world', runId: OTHER.runId } as const;
  const refuse = { kind: 'refuse', found: 'a process still runs', unseen: 'cleanup could not look' } as const;
  const remove = { kind: 'remove' } as const;

  it('refuses while a process of the world lives, naming each, and removes nothing', () => {
    const plan = cleanupPlan([
      { onCleanup: refuse, observed: [{ kind: 'observed', findings: [{ what: 'process 42 on this machine (sleep 900)', attribution: own }, { what: 'process 43 on this machine (x)', attribution: theirs }], notes: [] }] },
      { onCleanup: remove, observed: [{ kind: 'observed', findings: [{ what: 'docker container c', attribution: own, remove: ['docker', 'rm', '-f', 'c'] }], notes: [] }] },
    ]);

    expect(plan).toEqual({ kind: 'refuse', refusals: [{ why: 'a process still runs', items: ['process 42 on this machine (sleep 900)'] }] });
  });

  it('refuses when it could not look at the processes, since one of the world may still run there', () => {
    const plan = cleanupPlan([
      { onCleanup: refuse, observed: [{ kind: 'observed', findings: [], notes: [] }, { kind: 'not_observed', what: 'working directories on this machine', why: 'lsof listed none' }] },
      { onCleanup: remove, observed: [{ kind: 'observed', findings: [{ what: 'docker container c', attribution: own, remove: ['docker', 'rm', '-f', 'c'] }], notes: [] }] },
    ]);

    expect(plan).toEqual({ kind: 'refuse', refusals: [{ why: 'cleanup could not look', items: ['NOT OBSERVED: working directories on this machine, lsof listed none'] }] });
  });

  it("removes only the world's own removable leftovers, keeps what a row keeps, and says what it could not look at", () => {
    const plan = cleanupPlan([
      { onCleanup: refuse, observed: [{ kind: 'observed', findings: [], notes: [] }] },
      { onCleanup: { kind: 'keep' }, observed: [{ kind: 'observed', findings: [{ what: 'vercel sandbox v', attribution: own }], notes: [] }] },
      { onCleanup: remove, observed: [
        { kind: 'observed', findings: [{ what: 'docker container mine', attribution: own, remove: ['docker', 'rm', '-f', 'mine'] }, { what: 'docker container theirs', attribution: theirs, remove: ['docker', 'rm', '-f', 'theirs'] }], notes: [] },
        { kind: 'not_observed', what: 'podman containers', why: 'podman info failed' },
      ] },
    ]);

    expect(plan).toEqual({ kind: 'remove', removals: [{ what: 'docker container mine', command: ['docker', 'rm', '-f', 'mine'] }], unobserved: ['podman containers, podman info failed'] });
  });
});

describe('what cleanup prints when it refuses', () => {
  it("masks a passed key's value in the command line of the world process it names", async () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-verify-planned-')));
    roots.push(dir);
    const world: World = {
      runId: '20261112T180000-cccccc', dir, project: `${dir}/project`, team: `${dir}/team.git`, home: `${dir}/home`, tmp: `${dir}/tmp`, logs: `${dir}/logs`, bin: `${dir}/bin`,
      build: { commit: 'c', dirty: false, version: '0.0.0', tarball: 't.tgz', sha256: 's', node: 'v20' },
      createdAt: '2026-11-12T18:00:00.000Z',
      baseline: { teamRefs: {}, checkoutStatus: [] },
      passed: ['VERIFY_PLANNED_TOKEN'],
    };
    for (const folder of [world.project, world.home, world.tmp]) fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify(world));
    vi.stubEnv('VERIFY_PLANNED_TOKEN', 'pl4nned-s3cret');
    const left = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'pl4nned-s3cret', world.project], { cwd: world.project, stdio: 'ignore' });

    try {
      await new Promise((resolve) => left.once('spawn', resolve));
      const plan = await planCleanup(world);

      expect(plan.kind).toBe('refuse');
      if (plan.kind !== 'refuse') return;
      const lines = plan.refusals.flatMap((refusal) => refusal.items).join('\n');
      expect(lines).toContain(String(left.pid));
      expect(lines).toContain('<REDACTED:VERIFY_PLANNED_TOKEN>');
      expect(JSON.stringify(plan)).not.toContain('pl4nned-s3cret');
    } finally {
      signalChild(left, 'SIGKILL');
    }
  });
});

describe("a probe of an engine's listing", () => {
  it('ends one that ignores TERM at its time, and says NOT OBSERVED', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leftovers-probe-'));
    roots.push(root);
    // As an engine CLI stuck on a daemon that never answers, and that a TERM does not stop.
    const engine = path.join(root, 'engine');
    fs.writeFileSync(engine, '#!/bin/sh\ntrap "" TERM\nexec sleep 30\n', { mode: 0o755 });
    const started = Date.now();

    expect(probeHere([engine, 'ps'], { timeoutMs: 300 })).toEqual({ kind: 'ran', code: null, stdout: '', stderr: '', why: `NOT OBSERVED: ${engine} ps did not answer within 0.3 s` });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
