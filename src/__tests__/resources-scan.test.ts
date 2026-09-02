import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { buildConfigUiFixture, type ConfigUiFixture } from './helpers/config-ui-fixture.js';
import { createConfigUiServer, type ConfigUiServer } from '../config-ui.js';

let fixture: ConfigUiFixture;
let ui: ConfigUiServer;
let base: string;

beforeAll(async () => {
  fixture = buildConfigUiFixture();
  ui = await createConfigUiServer({ port: 0, scope: 'user' });
  await ui.start();
  base = `http://127.0.0.1:${ui.port}`;
});

afterAll(async () => {
  await ui.stop();
  fixture.cleanup();
});

async function getJson(p: string): Promise<any> {
  const res = await fetch(base + p);
  return res.json();
}

describe('GET /api/resources — full inventory', () => {
  it('counts every resource type from the fixture', async () => {
    const d = await getJson('/api/resources');
    // master branch: code-review, unit-test (core), deploy (ops), docs-writing (shared)
    expect(d.skills.count).toBe(4);
    expect(d.rules.count).toBe(2);
    expect(d.docs.count).toBe(2);
    expect(d.env.count).toBe(2);
    expect(d.agents.count).toBe(1);
    expect(d.hooks.count).toBe(1);
    expect(d.mcp.count).toBe(1);
    expect(d.culture.present).toBe(true);
    expect(d.roles.count).toBe(2);
    expect(d.roles.ids.sort()).toEqual(['dev', 'ops']);
    expect(d.recall.indexStatus).toBe('missing'); // no index built yet
  });

  it('marks skills active/inactive by the role namespaces (primaryRole=dev)', async () => {
    const d = await getJson('/api/resources');
    const byName = Object.fromEntries(d.skills.items.map((s: any) => [s.name, s]));
    expect(byName['code-review'].active).toBe(true); // ns core
    expect(byName['docs-writing'].active).toBe(true); // ns shared
    expect(byName['deploy'].active).toBe(false); // ns ops — not in dev binding
    expect(byName['code-review'].namespace).toBe('core');
    expect(byName['code-review'].description).toContain('评审');
    expect(byName['code-review'].installed).toBe(false); // no tool dirs in temp HOME
  });

  it('flags excluded skills', async () => {
    const cfgPath = path.join(fixture.home, '.teamai', 'config.yaml');
    const cfg = YAML.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.excludedSkills = ['unit-test'];
    fs.writeFileSync(cfgPath, YAML.stringify(cfg));

    const d = await getJson('/api/resources');
    const byName = Object.fromEntries(d.skills.items.map((s: any) => [s.name, s]));
    expect(byName['unit-test'].excluded).toBe(true);
    expect(byName['code-review'].excluded).toBe(false);

    delete cfg.excludedSkills;
    fs.writeFileSync(cfgPath, YAML.stringify(cfg));
  });

  it('lists env items as name + policy ONLY (secret never serialized)', async () => {
    const res = await fetch(base + '/api/resources');
    const raw = await res.text();
    expect(raw).not.toContain(fixture.envSecretValue);
    expect(raw).not.toContain('SUPER-SECRET');
    const d = JSON.parse(raw);
    const names = d.env.items.map((e: any) => e.name);
    expect(names.sort()).toEqual(['TEAM_API_ENDPOINT', 'TEAM_LOG_LEVEL']);
    expect(d.env.items[0].injectShellProfile).toBe(true);
    // No 'value' key anywhere in env items.
    for (const item of d.env.items) {
      expect(Object.keys(item).sort()).toEqual(['injectShellProfile', 'name']);
    }
  });

  it('carries hooks policy and command', async () => {
    const d = await getJson('/api/resources');
    const hook = d.hooks.items[0];
    expect(hook.name).toBe('block-force-push');
    expect(hook.autoApply).toBe(true);
    expect(hook.requireTeamScripts).toBe(false);
    expect(hook.command).toContain('block-force-push');
  });

  it('lists docs with frontmatter titles', async () => {
    const d = await getJson('/api/resources');
    const titles = Object.fromEntries(d.docs.items.map((x: any) => [x.name, x.title]));
    expect(titles['onboarding']).toBe('新人入职指南');
    expect(titles['arch/overview']).toBe('架构总览');
  });

  it('rules carry active state from tag filtering (subscribedTags empty = all)', async () => {
    const d = await getJson('/api/resources');
    for (const rule of d.rules.items) {
      expect(rule.active).toBe(true);
    }
  });
});
