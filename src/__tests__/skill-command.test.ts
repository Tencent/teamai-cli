import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { installSkillZip, executeSkillCommand, type SkillCommand } from '../skill-command.js';

let tmpDir: string;
let skillsDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-skillcmd-test-'));
  skillsDir = path.join(tmpDir, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Build a valid skill zip whose top level is `<slug>/`. */
function makeSkillZip(
  slug: string,
  extraFiles: Record<string, string> = {},
  opts: { name?: string } = {},
): Uint8Array {
  const skillName = opts.name ?? slug;
  const files: Record<string, Uint8Array> = {
    [`${slug}/SKILL.md`]: strToU8(`---\nname: ${skillName}\ndescription: test skill\n---\nbody`),
  };
  for (const [rel, content] of Object.entries(extraFiles)) {
    files[`${slug}/${rel}`] = strToU8(content);
  }
  return zipSync(files);
}

describe('installSkillZip', () => {
  it('extracts the <slug>/ subtree into targetSkillsDir/<slug>/', async () => {
    const zip = makeSkillZip('weather', { 'scripts/run.sh': 'echo hi' });
    await installSkillZip(zip, 'weather', skillsDir);

    expect(fs.existsSync(path.join(skillsDir, 'weather', 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(skillsDir, 'weather', 'scripts', 'run.sh'), 'utf-8')).toBe('echo hi');
  });

  it('rejects a package with no SKILL.md anywhere', async () => {
    const zip = zipSync({ 'weather/README.md': strToU8('no skill md') });
    await expect(installSkillZip(zip, 'weather', skillsDir)).rejects.toThrow(/missing weather\/SKILL\.md/);
  });

  it('accepts a flat zip (SKILL.md at root) and renames dir to SKILL.md name', async () => {
    const zip = zipSync({
      'SKILL.md': strToU8('---\nname: find-skills\ndescription: test\n---\nbody'),
      '_meta.json': strToU8('{"slug":"find-skills-skill"}'),
      'scripts/run.sh': strToU8('echo hi'),
    });
    const actualDir = await installSkillZip(zip, 'find-skills-skill', skillsDir);
    expect(actualDir).toBe('find-skills');
    expect(fs.existsSync(path.join(skillsDir, 'find-skills', 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(skillsDir, 'find-skills', 'scripts', 'run.sh'), 'utf-8')).toBe('echo hi');
    // Slug dir should not exist after rename
    expect(fs.existsSync(path.join(skillsDir, 'find-skills-skill'))).toBe(false);
  });

  it('accepts a nested zip whose top-level dir name differs from the slug and renames to SKILL.md name', async () => {
    const zip = zipSync({ 'find-skills/SKILL.md': strToU8('---\nname: find-skills\ndescription: test\n---\nbody') });
    const actualDir = await installSkillZip(zip, 'find-skills-skill', skillsDir);
    expect(actualDir).toBe('find-skills');
    expect(fs.existsSync(path.join(skillsDir, 'find-skills', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'find-skills-skill'))).toBe(false);
  });

  it('is overwrite-idempotent (re-install replaces prior content)', async () => {
    await installSkillZip(makeSkillZip('weather', { 'old.txt': 'old' }), 'weather', skillsDir);
    await installSkillZip(makeSkillZip('weather', { 'new.txt': 'new' }), 'weather', skillsDir);
    expect(fs.existsSync(path.join(skillsDir, 'weather', 'old.txt'))).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, 'weather', 'new.txt'))).toBe(true);
  });

  it('rejects a path-traversal entry in the archive', async () => {
    // Craft an archive with a malicious entry under the slug prefix.
    const zip = zipSync({
      'weather/SKILL.md': strToU8('---\nname: weather\n---'),
      'weather/../../escape.txt': strToU8('pwned'),
    });
    await expect(installSkillZip(zip, 'weather', skillsDir)).rejects.toThrow(/path traversal/);
  });

  it('rejects an unsafe slug', async () => {
    const zip = makeSkillZip('weather');
    await expect(installSkillZip(zip, '../evil', skillsDir)).rejects.toThrow(/Invalid resource name/);
  });

  it('renames dir to SKILL.md name when it differs from slug', async () => {
    const zip = makeSkillZip('doctor', {}, { name: 'dragon-doctor' });
    const actualDir = await installSkillZip(zip, 'doctor', skillsDir);
    expect(actualDir).toBe('dragon-doctor');
    expect(fs.existsSync(path.join(skillsDir, 'dragon-doctor', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'doctor'))).toBe(false);
    // Slug map should record the mapping
    const map = JSON.parse(fs.readFileSync(path.join(skillsDir, '_slug-map.json'), 'utf-8'));
    expect(map['doctor']).toBe('dragon-doctor');
  });

  it('returns slug as actualDir when SKILL.md name matches slug', async () => {
    const zip = makeSkillZip('weather');
    const actualDir = await installSkillZip(zip, 'weather', skillsDir);
    expect(actualDir).toBe('weather');
  });

  it('falls back to slug when SKILL.md has no name field', async () => {
    const zip = zipSync({
      'weather/SKILL.md': strToU8('---\ndescription: no name field\n---\nbody'),
    });
    const actualDir = await installSkillZip(zip, 'weather', skillsDir);
    expect(actualDir).toBe('weather');
    expect(fs.existsSync(path.join(skillsDir, 'weather', 'SKILL.md'))).toBe(true);
  });

  it('falls back to slug when SKILL.md name fails safety check', async () => {
    const zip = makeSkillZip('weather', {}, { name: '../evil' });
    const actualDir = await installSkillZip(zip, 'weather', skillsDir);
    expect(actualDir).toBe('weather');
    expect(fs.existsSync(path.join(skillsDir, 'weather', 'SKILL.md'))).toBe(true);
  });

  it('cleans up previously renamed dir on re-install', async () => {
    // First install: slug=doctor → renamed to dragon-doctor
    const zip1 = makeSkillZip('doctor', { 'v1.txt': 'v1' }, { name: 'dragon-doctor' });
    await installSkillZip(zip1, 'doctor', skillsDir);
    expect(fs.existsSync(path.join(skillsDir, 'dragon-doctor', 'v1.txt'))).toBe(true);

    // Re-install: slug=doctor → still renamed to dragon-doctor, old content replaced
    const zip2 = makeSkillZip('doctor', { 'v2.txt': 'v2' }, { name: 'dragon-doctor' });
    await installSkillZip(zip2, 'doctor', skillsDir);
    expect(fs.existsSync(path.join(skillsDir, 'dragon-doctor', 'v2.txt'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'dragon-doctor', 'v1.txt'))).toBe(false);
  });
});

describe('executeSkillCommand', () => {
  it('install_skill downloads, unzips and installs', async () => {
    const zip = makeSkillZip('weather');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(zip as unknown as BodyInit, { status: 200 })));

    const cmd: SkillCommand = {
      id: 1,
      type: 'install_skill',
      skill_slug: 'weather',
      skill_version: '1.0.0',
      download_url: 'https://smh.example.com/pkg.zip?access_token=x',
    };
    await executeSkillCommand(cmd, skillsDir);
    expect(fs.existsSync(path.join(skillsDir, 'weather', 'SKILL.md'))).toBe(true);
  });

  it('install_skill requires a download_url', async () => {
    const cmd: SkillCommand = { type: 'install_skill', skill_slug: 'weather' };
    await expect(executeSkillCommand(cmd, skillsDir)).rejects.toThrow(/requires download_url/);
  });

  it('uninstall_skill removes the directory and is idempotent', async () => {
    fs.mkdirSync(path.join(skillsDir, 'weather'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'weather', 'SKILL.md'), 'x');

    await executeSkillCommand({ type: 'uninstall_skill', skill_slug: 'weather' }, skillsDir);
    expect(fs.existsSync(path.join(skillsDir, 'weather'))).toBe(false);

    // Second uninstall on a missing dir is a no-op success.
    await expect(
      executeSkillCommand({ type: 'uninstall_skill', skill_slug: 'weather' }, skillsDir),
    ).resolves.toBeUndefined();
  });

  it('uninstall_skill removes renamed dir via slug map', async () => {
    // Install with slug → renamed dir
    const zip = makeSkillZip('doctor', {}, { name: 'dragon-doctor' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(zip as unknown as BodyInit, { status: 200 })));

    await executeSkillCommand({
      type: 'install_skill',
      skill_slug: 'doctor',
      download_url: 'https://smh.example.com/pkg.zip',
    }, skillsDir);
    expect(fs.existsSync(path.join(skillsDir, 'dragon-doctor', 'SKILL.md'))).toBe(true);

    // Uninstall by slug — should find the renamed dir via slug map
    await executeSkillCommand({ type: 'uninstall_skill', skill_slug: 'doctor' }, skillsDir);
    expect(fs.existsSync(path.join(skillsDir, 'dragon-doctor'))).toBe(false);
    // Slug map should be cleaned up
    expect(fs.existsSync(path.join(skillsDir, '_slug-map.json'))).toBe(false);
  });

  it('install_skill surfaces a non-200 download as an error (ack failed path)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    const cmd: SkillCommand = {
      type: 'install_skill',
      skill_slug: 'weather',
      download_url: 'https://smh.example.com/missing.zip',
    };
    await expect(executeSkillCommand(cmd, skillsDir)).rejects.toThrow(/HTTP 404/);
  });
});
