import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { extractCodebase } from '../codebase-extract.js';
import { CodebaseEnrich } from '../enrich-with-ai.js';
import { log } from '../utils/logger.js';

const temporaryDirectories: string[] = [];

const MODULE_REPLY = {
  src: '{"domain":"widgets","responsibilities":["render"],"layer":"service","summary":"draws widgets"}',
  lib: '{"domain":"widgets","responsibilities":["helpers"],"layer":"data","summary":"shared helpers"}',
} as const;

const DOMAIN_REPLY = '{"domain":"UI kit","description":"renders widgets","keywords":["widget","render"]}';

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** A checkout with two modules of five classes each, so AI enrich asks about both. */
function twoModuleCheckout(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-enrich-'));
  temporaryDirectories.push(root);
  const classes = (prefix: string) => Array.from({ length: 5 }, (_, index) => `export class ${prefix}${index} { run() { return ${index}; } }`).join('\n') + '\n';
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), `import { Util0 } from '../lib/util';\n${classes('App')}`);
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'lib', 'util.ts'), classes('Util'));

  return root;
}

function evidence(root: string): { manifest: unknown; domains: unknown } {
  const dir = path.join(root, 'teamwiki', 'evidence', 'code', 'widget');
  const { generatedAt: _generatedAt, ...manifest } = JSON.parse(fs.readFileSync(path.join(dir, '_manifest.json'), 'utf8')) as Record<string, unknown>;

  return { manifest, domains: JSON.parse(fs.readFileSync(path.join(dir, '_domains.json'), 'utf8')) };
}

/** Runs the steps of a teamai-codebase-enrich run as its workflow does, answering each module by name. */
async function enrichSteps(wikiRoot: string, answers: { module: (name: string) => { text: string; failure: string }; domain: { text: string; failure: string } }) {
  const target = { project: 'widget', wikiRoot };
  const planned = await CodebaseEnrich.plan(target);
  const results = JSON.stringify(planned.modules.map((item) => ({ item, outcome: 'success', outputs: answers.module(item.name) })));
  const replies = CodebaseEnrich.repliesOf(results);

  if (!replies.ok) throw new Error(replies.message);
  const summary = CodebaseEnrich.summary('widget', replies.replies);

  const domain = summary.count > 0 ? answers.domain : { text: '', failure: '' };

  return { planned, summary, written: await CodebaseEnrich.write(target, replies.replies, domain) };
}

describe('teamai-codebase-enrich steps', () => {
  it('write the manifest and domains AI enrich always wrote', async () => {
    const stepped = twoModuleCheckout();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await extractCodebase({ path: stepped, project: 'widget', json: true, skipEnrich: true });
    const ran = await enrichSteps(path.join(stepped, 'teamwiki'), {
      module: (name) => ({ text: MODULE_REPLY[name === 'lib' ? 'lib' : 'src'], failure: '' }),
      domain: { text: DOMAIN_REPLY, failure: '' },
    });

    expect(ran.planned.modules.map((item) => item.name)).toEqual(['src', 'lib']);
    expect(ran.summary).toEqual({ count: 2, project: 'widget', modules: 'src: domain=widgets, layer=service, summary=draws widgets\nlib: domain=widgets, layer=data, summary=shared helpers' });
    expect(ran.written).toEqual({ modules: 2, domain: 'UI kit' });
    // What the in-process enrich wrote for these replies before it was a workflow.
    expect(evidence(stepped)).toEqual({
      manifest: {
        schemaVersion: 'team-wiki.codebase-output-manifest.v2',
        project: 'widget',
        components: [
          {
            slug: 'src', docPath: 'evidence/code/widget/src.md', title: 'src', category: 'service', confidence: 'INFERRED', responsibilities: ['render'],
            entrypoints: ['App0 (src/app.ts:2)', 'App1 (src/app.ts:3)', 'App2 (src/app.ts:4)', 'App3 (src/app.ts:5)', 'App4 (src/app.ts:6)'],
          },
          { slug: 'lib', docPath: 'evidence/code/widget/lib.md', title: 'lib', category: 'data', confidence: 'INFERRED', responsibilities: ['helpers'], entrypoints: [] },
        ],
        edges: [{ from: 'src', to: 'lib', relation: 'DEPENDS_ON', confidence: 'EXTRACTED', source: 'code-ast', reason: 'src imports from lib' }],
      },
      domains: { domain: 'UI kit', description: 'renders widgets', keywords: ['widget', 'render'], components: ['src', 'lib'] },
    });
  });

  it('plans the facts the module prompt names', async () => {
    const root = twoModuleCheckout();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await extractCodebase({ path: root, project: 'widget', json: true, skipEnrich: true });

    const planned = await CodebaseEnrich.plan({ project: 'widget', wikiRoot: path.join(root, 'teamwiki') });

    expect(planned).toEqual({
      modules: [
        { name: 'src', files: 'src/app.ts', components: 'App0, App1, App2, App3, App4', interfaces: '无' },
        { name: 'lib', files: 'lib/util.ts', components: 'Util0, Util1, Util2, Util3, Util4', interfaces: '无' },
      ],
      interfaces: '无',
    });
  });

  it('keep the fallback manifest when a module could not be asked', async () => {
    const root = twoModuleCheckout();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await extractCodebase({ path: root, project: 'widget', json: true, skipEnrich: true });
    const fallback = fs.readFileSync(path.join(root, 'teamwiki', 'evidence', 'code', 'widget', '_manifest.json'), 'utf8');
    const warn = vi.spyOn(log, 'warn');

    const ran = await enrichSteps(path.join(root, 'teamwiki'), {
      module: (name) => name === 'lib' ? { text: '', failure: 'tool_failed' } : { text: MODULE_REPLY.src, failure: '' },
      domain: { text: DOMAIN_REPLY, failure: '' },
    });

    expect(ran.summary.count).toBe(0);
    expect(ran.written).toEqual({ modules: 0, domain: '' });
    expect(warn).toHaveBeenCalledWith('enrichWithAI: module analysis failed (non-blocking): 1 AI task(s) failed');
    expect(fs.readFileSync(path.join(root, 'teamwiki', 'evidence', 'code', 'widget', '_manifest.json'), 'utf8')).toBe(fallback);
  });

  it('leave out a module whose reply names no domain and keep the modules whose reply does', async () => {
    const root = twoModuleCheckout();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await extractCodebase({ path: root, project: 'widget', json: true, skipEnrich: true });

    await enrichSteps(path.join(root, 'teamwiki'), {
      module: (name) => ({ text: name === 'lib' ? '{"responsibilities":["helpers"],"summary":"shared helpers"}' : MODULE_REPLY.src, failure: '' }),
      domain: { text: DOMAIN_REPLY, failure: '' },
    });

    // An array matches only at the same length: lib is left out.
    expect(evidence(root).manifest).toMatchObject({ components: [{ slug: 'src', category: 'service' }] });
  });

  it('write the manifest without a domain when the domain could not be asked', async () => {
    const root = twoModuleCheckout();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await extractCodebase({ path: root, project: 'widget', json: true, skipEnrich: true });

    const ran = await enrichSteps(path.join(root, 'teamwiki'), {
      module: (name) => ({ text: MODULE_REPLY[name === 'lib' ? 'lib' : 'src'], failure: '' }),
      domain: { text: '', failure: 'AI call failed (tool: claude): Authentication failed' },
    });

    expect(ran.written).toEqual({ modules: 2, domain: '' });
    expect(evidence(root).domains).toEqual({ domain: '', description: '', keywords: [], components: [] });
  });

  it('plans from the caches import published beside the evidence, and never from another codebase\'s', async () => {
    const root = twoModuleCheckout();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await extractCodebase({ path: root, project: 'widget', json: true, skipEnrich: true });
    const wikiRoot = path.join(root, 'teamwiki');
    fs.cpSync(path.join(wikiRoot, '.indices'), path.join(wikiRoot, 'evidence', 'code', 'widget', '.indices'), { recursive: true });
    fs.rmSync(path.join(wikiRoot, 'source-manifest.json'));

    expect((await CodebaseEnrich.plan({ project: 'widget', wikiRoot })).modules.map((item) => item.name)).toEqual(['src', 'lib']);
    expect((await CodebaseEnrich.plan({ project: 'other', wikiRoot })).modules).toEqual([]);
  });

  it('plans no module when none has five facts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-enrich-small-'));
    temporaryDirectories.push(root);
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'widget.ts'), 'export class Widget {\n  render() { return "hi"; }\n}\n');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await extractCodebase({ path: root, project: 'widget', json: true, skipEnrich: true });

    expect((await CodebaseEnrich.plan({ project: 'widget', wikiRoot: path.join(root, 'teamwiki') })).modules).toEqual([]);
  });

  it('rejects replies that are not the results of the modules step', () => {
    expect(CodebaseEnrich.repliesOf('{"text":"x"}')).toMatchObject({ ok: false });
    expect(CodebaseEnrich.repliesOf('not json')).toMatchObject({ ok: false });
  });

  it('refuses a codebase outside evidence/code', () => {
    expect(CodebaseEnrich.targetOf({ wikiRoot: '/tmp/wiki', codebase: '../escape' })).toMatchObject({ ok: false });
    expect(CodebaseEnrich.targetOf({ wikiRoot: '/tmp/wiki', codebase: 'widget' })).toEqual({ ok: true, target: { project: 'widget', wikiRoot: '/tmp/wiki' } });
  });
});
