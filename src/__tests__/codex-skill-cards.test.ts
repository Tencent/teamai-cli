import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readUsageEvents, resolvePromptSkills, trackPromptSkills } from '../usage-tracker.js';
import type { LocalConfig } from '../types.js';

let home: string;
let config: LocalConfig;
const originalHome = process.env.HOME;
const originalCwd = process.cwd();
const skillPath = (name = 'sample-review') => path.join(home, '.codex', 'skills', name, 'SKILL.md');
const chip = (name = 'sample-review', file = skillPath(name)) => `[$${name}](${file})`;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-chip-unit-'));
  process.env.HOME = home;
  process.chdir(home);
  for (const name of ['sample-review', 'other-review']) {
    await fs.mkdir(path.dirname(skillPath(name)), { recursive: true });
    await fs.writeFile(skillPath(name), `---\nname: ${name}\ndescription: Synthetic review\n---\n`);
  }
  config = { scope: 'user', username: 'tester', additionalRoles: [],
    repo: { localPath: path.join(home, '.teamai', 'team-repo'), remote: 'https://example.invalid/team.git' } };
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  process.env.HOME = originalHome;
  await fs.rm(home, { recursive: true, force: true });
});

describe('Codex skill card usage', () => {
  it('accepts the real Codex source-directory format with and without a trailing slash', async () => {
    const directory = 'teamai/skills/general/sample-review';
    await fs.mkdir(directory, { recursive: true });
    await fs.copyFile(skillPath(), path.join(directory, 'SKILL.md'));
    for (const suffix of ['', '/']) {
      expect(await resolvePromptSkills(`[sample-review](${directory}${suffix}) Review sample`, 'codex'))
        .toEqual(['sample-review']);
    }
    expect(await resolvePromptSkills(`[sample-review](${directory}/) Review`, 'claude')).toEqual([]);
  });

  it('accepts installed skill directory cards but leaves ordinary file links uncounted', async () => {
    const directory = path.dirname(skillPath());
    expect(await resolvePromptSkills(`[sample-review](${directory}) Review`, 'tcodex')).toEqual(['sample-review']);
    expect(await resolvePromptSkills(`[sample-review](${skillPath()}) Review`, 'codex')).toEqual([]);
  });

  it('rejects ordinary, missing, external, escaped, and mismatched directory links', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-chip-outside-'));
    try {
      const paths = ['docs/sample-review', 'teamai/skills/general/other-review',
        'teamai/skills/general/missing-review', 'teamai/skills/general/sample-review'];
      for (const directory of paths) await fs.mkdir(directory, { recursive: true });
      await fs.copyFile(skillPath(), 'docs/sample-review/SKILL.md');
      await fs.copyFile(skillPath('other-review'), 'teamai/skills/general/other-review/SKILL.md');
      await fs.writeFile('teamai/skills/general/missing-review/SKILL.md', '---\nname: missing-review\ndescription: Missing\n---\n');
      const external = path.join(outside, 'skills/sample-review');
      await fs.mkdir(external, { recursive: true });
      await fs.copyFile(skillPath(), path.join(external, 'SKILL.md'));
      await fs.mkdir('linked/skills', { recursive: true });
      await fs.symlink(external, 'linked/skills/sample-review');
      const prompts = [
        '[sample-review](docs/sample-review/)', '[sample-review](teamai/skills/general/other-review/)',
        '[missing-review](teamai/skills/general/missing-review/)', '[sample-review](teamai/skills/general/sample-review/)',
        `[sample-review](${external}/)`, '[sample-review](linked/skills/sample-review/)',
        '[sample-review](https://example.invalid/skills/sample-review/)',
        'Use [sample-review](.codex/skills/sample-review/) in prose', '[sample-review](.codex/skills/no-such-dir/)',
      ];
      for (const prompt of prompts) expect(await resolvePromptSkills(prompt, 'codex'), prompt).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('requires valid matching skill frontmatter for a source directory card', async () => {
    const directory = 'teamai/skills/general/sample-review';
    await fs.mkdir(directory, { recursive: true });
    for (const content of ['# Ordinary document', '---\nname: other-review\ndescription: Review\n---\n',
      '---\nname: sample-review\n---\n', '---\nname: [broken\n---\n']) {
      await fs.writeFile(path.join(directory, 'SKILL.md'), content);
      expect(await resolvePromptSkills(`[sample-review](${directory}/) Review`, 'codex')).toEqual([]);
    }
  });

  it('deduplicates directory, slash and dollar selections together and across retries', async () => {
    const directory = 'teamai/skills/general/sample-review';
    await fs.mkdir(directory, { recursive: true });
    await fs.copyFile(skillPath(), path.join(directory, 'SKILL.md'));
    const prompt = `[sample-review](${directory}/) /sample-review ${chip()} [sample-review](${directory}) Review`;
    const payload = { prompt, event_id: 'directory-event', session_id: 'synthetic-session', cwd: home };
    await Promise.all([trackPromptSkills(payload, 'codex', config), trackPromptSkills(payload, 'codex', config)]);
    expect(await readUsageEvents(config)).toHaveLength(1);
    await trackPromptSkills({ ...payload, event_id: 'new-directory-event' }, 'codex', config);
    expect(await readUsageEvents(config)).toHaveLength(2);
  });

  it('counts distinct leading selections and deduplicates slash/card repetitions', async () => {
    expect(await resolvePromptSkills(`  /sample-review ${chip()} ${chip('other-review')} Review`, 'codex'))
      .toEqual(['sample-review', 'other-review']);
  });

  it('rejects prose, ordinary links, arbitrary @ text, and non-Codex cards', async () => {
    for (const prompt of [`Use ${chip()}`, `[sample-review](${skillPath()})`, '@sample-review Review',
      `Review /sample-review`, `/unknown-command ${chip()} prose ${chip('other-review')}`]) {
      expect(await resolvePromptSkills(prompt, 'codex')).toEqual(prompt.startsWith('/unknown') ? ['sample-review'] : []);
    }
    expect(await resolvePromptSkills(chip(), 'claude')).toEqual([]);
  });

  it('requires the selected local SKILL.md and matching skill name', async () => {
    const outside = path.join(home, 'outside', 'sample-review', 'SKILL.md');
    await fs.mkdir(path.dirname(outside), { recursive: true });
    await fs.writeFile(outside, '---\nname: sample-review\n---\n');
    for (const prompt of [chip('sample-review', outside), chip('sample-review', skillPath('other-review')),
      chip('sample-review', 'https://example.invalid/sample-review/SKILL.md'),
      chip('sample-review', skillPath() + '.bak'), chip('missing-review'), '[$../sample-review](../SKILL.md)']) {
      expect(await resolvePromptSkills(prompt, 'codex')).toEqual([]);
    }
  });

  it('accepts a local symlink only when it resolves to the installed skill', async () => {
    const alias = path.join(home, 'alias', 'sample-review', 'SKILL.md');
    await fs.mkdir(path.dirname(alias), { recursive: true });
    await fs.symlink(skillPath(), alias);
    expect(await resolvePromptSkills(chip('sample-review', alias), 'codex-internal')).toEqual(['sample-review']);
  });

  it('deduplicates concurrent retries and survives usage truncation', async () => {
    const payload = { prompt: `${chip()} ${chip()} Review sample`, session_id: 'sample-session', event_id: 'sample-event', cwd: home };
    await Promise.all([trackPromptSkills(payload, 'codex', config), trackPromptSkills(payload, 'codex', config)]);
    expect(await readUsageEvents(config)).toHaveLength(1);
    const usage = path.join(home, '.teamai', 'user-usage.jsonl');
    await fs.writeFile(usage, '');
    await trackPromptSkills(payload, 'codex', config);
    expect(await readUsageEvents(config)).toEqual([]);
    await trackPromptSkills({ ...payload, event_id: 'next-event' }, 'codex', config);
    expect(await readUsageEvents(config)).toHaveLength(1);
    const receipt = await fs.readFile(`${usage}.prompts.json`, 'utf8');
    expect(receipt).not.toContain(payload.prompt);
    expect(receipt).not.toContain(home);
    expect((await fs.stat(`${usage}.prompts.json`)).mode & 0o777).toBe(0o600);
  });

  it('keeps receipt deduplication local to each data scope', async () => {
    const payload = { prompt: chip(), session_id: 'sample-session', event_id: 'sample-event', cwd: home };
    await trackPromptSkills(payload, 'codex', config);
    const project = { ...config, scope: 'project' as const, dataHome: path.join(home, 'project-data') };
    await trackPromptSkills(payload, 'codex', project);
    expect(await readUsageEvents(config)).toHaveLength(1);
    expect(await readUsageEvents(project)).toHaveLength(1);
  });

  it('counts a later identical prompt when no host event identifier is available', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const payload = { prompt: chip(), session_id: 'sample-session', cwd: home };
    await trackPromptSkills(payload, 'codex', config);
    await trackPromptSkills(payload, 'codex', config);
    expect(await readUsageEvents(config)).toHaveLength(1);
    now += 5_001;
    await trackPromptSkills(payload, 'codex', config);
    expect(await readUsageEvents(config)).toHaveLength(2);
  });

  it('bounds receipt history without storing prompt text', async () => {
    const receiptPath = path.join(home, '.teamai', 'user-usage.jsonl.prompts.json');
    await fs.mkdir(path.dirname(receiptPath), { recursive: true });
    await fs.writeFile(receiptPath, JSON.stringify(Array.from({ length: 256 }, (_, i) => ({ key: `old-${i}`, at: 0 }))));
    await trackPromptSkills({ prompt: chip(), session_id: 'sample-session', event_id: 'new-event', cwd: home }, 'codex', config);
    const receipts = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    expect(receipts).toHaveLength(256);
    expect(receipts[0].key).toBe('old-1');
    expect(receipts[255].key).toMatch(/^[a-f0-9]{64}$/);
  });
});
