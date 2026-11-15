import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseYaml } from '@teamai/shared/yaml';
import { dir, worktree, daemon, behave, received, start, isEnd, isInit, ready, opened, cannotRun, notInstalled, promptRequest, SHIPPED_HOME_ENV, useRuntimeSuite } from './testing/suite.js';

/** The `exec` teamai's own runtime `name` declares in its marker (`runtimes/teamai-<name>.yaml`), which teamai reads without starting it. */
function declaredExec(name: string): unknown {
  const marker = z.object({ exec: z.unknown() }).parse(parseYaml(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'runtimes', `teamai-${name}.yaml`), 'utf8')));

  return marker.exec;
}

describe('teamai-runtime-paseo', () => {
  useRuntimeSuite();

  it('offers prompt steps only, in the checkout, a new or continued worktree, or a clone or team clone teamai prepares, with the role teamai delivered there, with no env, token count or unattended mode, for the tools the daemon can run', async () => {
    // The daemon runs on this machine, where `codex login status` says Codex is signed in.
    behave({ models: { claude: ['claude-opus-5-5'], codex: ['gpt-6.1-sol'], opencode: ['opencode/beam-free'] }, codex_login: 'signed_in' });

    const reply = await ready(start());

    expect(reply).toEqual({
      type: 'init', ok: true, prompt: true, conversations: true, confinedPrompt: true, wake: true,
      can: {
        exec: false, setup: false, hitl: false, unattended: false, env: false, tokens: false, max_turns: false, workspace: ['read-only', 'new', 'continue', 'clone', 'team'], role: true, tools: ['claude', 'codex', 'opencode'],
        confined: [{ level: 'best-effort', access: 'read', tools: ['claude', 'codex', 'opencode'] }],
      },
    });
    // teamai skips the runtime for a run that needs no AI tool by what its manifest declares, never asking init.
    expect(declaredExec('paseo')).toBe(z.object({ can: z.object({ exec: z.boolean() }) }).parse(reply).can.exec);
  });

  // Every success report of its prompt steps then carries their tokens, read from the session on this machine.
  it.each<{ when: string; models: Record<string, string[]>; claudeHome: boolean; url?: (url: string) => string; unlistable?: string; tokens: boolean }>([
    { when: 'reports tokens when it runs only Claude and Codex, whose sessions it reads on a daemon on this machine', models: { claude: ['claude-opus-5-5'], codex: ['gpt-6.1-sol'] }, claudeHome: true, tokens: true },
    { when: 'reports no tokens when it also runs OpenCode, whose session database it does not read', models: { claude: ['claude-opus-5-5'], opencode: ['opencode/beam-free'] }, claudeHome: true, tokens: false },
    { when: 'reports no tokens when Claude does not say which home keeps its sessions', models: { claude: ['claude-opus-5-5'] }, claudeHome: false, tokens: false },
    { when: 'reports no tokens on a daemon on another host', models: { claude: ['claude-opus-5-5'] }, claudeHome: true, url: (url) => url.replace('127.0.0.1', '0.0.0.0'), tokens: false },
    // The daemon runs as another user, whose tool home teamai cannot list.
    ...(process.platform === 'win32' ? [] : [
      { when: 'reports no tokens when teamai cannot list the folder Claude keeps its sessions in', models: { claude: ['claude-opus-5-5'] }, claudeHome: true, unlistable: '.claude/projects', tokens: false },
      { when: 'reports no tokens when teamai cannot list the home Codex keeps its sessions in', models: { codex: ['gpt-6.1-sol'] }, claudeHome: false, unlistable: '.codex/sessions', tokens: false },
    ]),
  ])('$when', async ({ models, claudeHome, url, unlistable, tokens }) => {
    behave({ models, codex_login: 'signed_in', ...(claudeHome && { claude_home: path.join(dir, 'daemon-user', '.claude') }) });
    const home = unlistable && path.join(dir, 'daemon-user', unlistable);

    if (home) {
      fs.mkdirSync(home, { recursive: true });
      fs.chmodSync(home, 0o300);
    }

    try {
      expect(await ready(start({ CODEX_HOME: path.join(dir, 'daemon-user', '.codex') }), url ? { options: { url: url(daemon.url) } } : {})).toMatchObject({ ok: true, can: { tools: Object.keys(models), tokens } });
    } finally {
      if (home) fs.chmodSync(home, 0o700);
    }
  });

  it.skipIf(process.platform === 'win32')('reports tokens for a Codex whose Paseo provider sets its home, though teamai cannot list another home that Codex does not use', async () => {
    const providerHome = path.join(dir, 'paseo-homes', 'acme-codex');
    // teamai's own home for the instance, where its Codex would keep its sessions had the provider not moved it.
    const elsewhere = path.join(dir, 'home', '.codex-acme', 'sessions');
    fs.mkdirSync(path.join(providerHome, 'sessions'), { recursive: true });
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.chmodSync(elsewhere, 0o300);
    behave({
      models: { codex: ['gpt-6.1-sol'] }, codex_login: 'signed_in', codex_login_home: providerHome,
      custom_providers: { 'codex-acme': { extends: 'codex', command: ['/opt/acme/bin/acme-codex'], env: { CODEX_HOME: providerHome } } },
    });

    try {
      expect(await ready(start(), {
        instances: [{ name: 'acme-codex', tool: 'codex', command: 'acme-codex', home: { dir: '.codex-acme' }, homeEnv: ['CODEX_HOME'] }],
      })).toMatchObject({ ok: true, can: { tools: ['acme-codex'], tokens: true } });
    } finally {
      fs.chmodSync(elsewhere, 0o700);
    }
  });

  // teamai names each tool's home variables in init, and the runtime finds the home a provider sets through those alone.
  it.skipIf(process.platform === 'win32').each<{ sent: string; homeEnv: Record<string, string[]>; offered: string[] }>([
    { sent: 'CODEX_HOME, as teamai sends it for Codex', homeEnv: { codex: ['CODEX_HOME'] }, offered: ['codex'] },
    { sent: 'no variable, when teamai sends none', homeEnv: {}, offered: [] },
  ])('checks a shipped Codex on the provider the definition names in the home that provider sets through $sent', async ({ homeEnv, offered }) => {
    const providerHome = path.join(dir, 'paseo-homes', 'codex-work');
    fs.mkdirSync(path.join(providerHome, 'sessions'), { recursive: true });
    behave({
      models: { codex: ['gpt-6.1-sol'] }, codex_login: 'signed_in', codex_login_home: providerHome,
      custom_providers: { 'codex-work': { extends: 'codex', env: { CODEX_HOME: providerHome } } },
    });

    expect(await ready(start(), { options: { url: daemon.url, providers: { codex: 'codex-work' } }, homeEnv })).toMatchObject({ ok: true, can: { tools: offered } });
  });

  it('offers neither a step nor a judge on a tool installed but signed out, which Paseo still calls available, and names it unavailable with how to sign it in', async () => {
    behave({ models: { claude: ['claude-opus-5-5'], opencode: ['opencode/beam-free'] }, sign_in: { claude: 'signed_out' } });

    expect(await ready(start())).toMatchObject({
      ok: true, can: { tools: ['opencode'], confined: [{ tools: ['opencode'] }] },
      unavailable: { claude: cannotRun('claude', 'signed out; run `claude auth login` on the daemon\'s host'), codex: cannotRun('codex', notInstalled('codex')) },
    });
  });

  it('starts though the daemon can run none of the tools, so command steps still run elsewhere, naming each tool unavailable with what it lacks and how to sign it in', async () => {
    // OpenCode reaches no model provider: Paseo lists no model for it, though its own free models need no sign-in.
    behave({ models: { claude: ['claude-opus-5-5'], codex: ['gpt-6.1-sol'], opencode: [] }, sign_in: { claude: 'signed_out' }, codex_login: 'signed_out' });

    expect(await ready(start())).toEqual({
      type: 'init', ok: true, prompt: true, conversations: true, wake: true,
      can: { exec: false, setup: false, hitl: false, unattended: false, env: false, tokens: false, max_turns: false, workspace: ['read-only', 'new', 'continue', 'clone', 'team'], role: true, tools: [] },
      unavailable: {
        claude: cannotRun('claude', 'signed out; run `claude auth login` on the daemon\'s host'),
        codex: cannotRun('codex', 'signed out; run `codex login` on the daemon\'s host'),
        opencode: cannotRun('opencode', 'reaches no model provider; run `opencode auth login` on the daemon\'s host, then `paseo restart`'),
      },
    });
  });

  it('does not offer OpenCode where Paseo shares OpenCode\'s own background server, which takes no environment for an agent, and names the remedy', async () => {
    behave({ models: { opencode: ['opencode/beam-free'] }, opencode_server: 'http://127.0.0.1:49374' });

    expect(await ready(start())).toMatchObject({
      ok: true, can: { tools: [] },
      unavailable: {
        opencode: cannotRun('opencode', 'Paseo runs it on OpenCode\'s background server at http://127.0.0.1:49374, which takes no environment for an agent, and teamai gives each step TEAMAI_RUN_DIR; stop that server with `opencode service stop` on the daemon\'s host, then `paseo restart`'),
      },
    });
  });

  it('fails a check when it can run no tool, so no run is offered where its prompt steps could not start', async () => {
    behave({ models: { opencode: ['opencode/beam-free'] }, opencode_server: 'http://127.0.0.1:49374' });

    expect(await ready(start(), { mode: 'check' })).toEqual({
      type: 'init', ok: false,
      error: { code: 'tool_unavailable', message: expect.stringContaining(`teamai-runtime-paseo can run no tool on the Paseo daemon at ${daemon.url} now: The Paseo daemon at ${daemon.url} cannot run claude`) },
    });
    expect(received()).toEqual([]);
  });

  it('starts though the daemon has none of the tools installed, naming each unavailable with how to install it', async () => {
    behave({ models: {} });

    expect(await ready(start())).toMatchObject({
      ok: true, can: { tools: [] },
      unavailable: { claude: cannotRun('claude', notInstalled('claude')), codex: cannotRun('codex', notInstalled('codex')), opencode: cannotRun('opencode', notInstalled('opencode')) },
    });
  });

  it('starts though Paseo fails one tool\'s diagnostic and another\'s modes listing, naming each of those unavailable with Paseo\'s error and still offering the rest', async () => {
    behave({ provider_errors: { claude: { request: 'diagnostic', error: 'claude auth status crashed' }, opencode: { request: 'modes', error: 'OpenCode SDK did not start' } } });

    expect(await ready(start())).toMatchObject({
      type: 'init', ok: true, can: { tools: [] },
      unavailable: {
        claude: cannotRun('claude', 'Paseo failed its diagnostic (claude auth status crashed); run `paseo provider diagnostic claude` on the daemon\'s host to see why'),
        opencode: cannotRun('opencode', 'Paseo failed to list its modes (OpenCode SDK did not start); run `paseo provider ls` on the daemon\'s host to see why'),
      },
    });
  });

  it('starts a Codex agent in the mode Paseo sets as its default, auto-review, on the daemon\'s default model, writing the result file\'s directory and the run\'s scratch directory without asking', async () => {
    behave({ output: { verdict: 'approve' }, codex_login: 'signed_in' });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { tool: 'codex', model: undefined }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'codex' }, result: { output: { verdict: 'approve' } } });
    // Codex's `auto-review` mode writes its worktree without asking, and asks before writing anywhere else.
    expect(received()).toMatchObject([{
      config: { provider: 'codex', model: 'gpt-6.1-sol', modeId: 'auto-review', cwd: worktree, providerOptions: { sandbox_workspace_write: { writable_roots: [path.join(dir, 'out'), path.join(dir, 'run')] } } },
    }]);
  });

  it('starts a tool whose Paseo default is a bypass mode in the next tighter mode Paseo lists, never in the bypass mode', async () => {
    // Paseo marks Claude's bypassPermissions and Codex's full-access as modes that never ask.
    behave({ output: { ok: true }, codex_login: 'signed_in', default_modes: { claude: 'bypassPermissions', codex: 'full-access' } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    runtime.send(promptRequest(handle, 'op-0000000c', { tool: 'codex', model: undefined }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished' });
    expect(await runtime.next(isEnd('op-0000000c'))).toMatchObject({ event: 'finished' });
    expect(received().map((create) => create.config)).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'claude', modeId: 'auto' }),
      expect.objectContaining({ provider: 'codex', modeId: 'auto-review' }),
    ]));
  });

  it('says once at start, for each tool, that its steps start in a tighter mode than the bypass mode Paseo sets as its default', async () => {
    behave({ codex_login: 'signed_in', default_modes: { claude: 'bypassPermissions', codex: 'full-access' } });
    const runtime = start();

    expect(await ready(runtime)).toMatchObject({ ok: true });
    expect(runtime.lines.filter((line) => 'event' in line && line.event === 'notice')).toEqual([
      { event: 'notice', message: 'Paseo starts claude in mode bypassPermissions by default, which never asks before it acts; teamai starts its claude steps in mode auto, the nearest one before it in Paseo\'s list that asks.' },
      { event: 'notice', message: 'Paseo starts codex in mode full-access by default, which never asks before it acts; teamai starts its codex steps in mode auto-review, the nearest one before it in Paseo\'s list that asks.' },
    ]);
  });

  it('starts a tool in the bypass mode its mode option names, reporting that tool alone in permissions as full access and offering no unattended step', async () => {
    behave({ output: { ok: true }, codex_login: 'signed_in', default_modes: { codex: 'full-access' } });
    const runtime = start();

    expect(await ready(runtime, { options: { url: daemon.url, mode: { claude: 'bypassPermissions' } } })).toMatchObject({
      type: 'init', ok: true, permissions: { claude: 'full-access' }, can: { unattended: false, tools: ['claude', 'codex', 'opencode'] },
    });
    // Codex's default is still never inherited: only the option opts a tool in.
    expect(runtime.lines.filter((line) => 'event' in line && line.event === 'notice').map((line) => 'message' in line && line.message)).toEqual([
      'Paseo starts codex in mode full-access by default, which never asks before it acts; teamai starts its codex steps in mode auto-review, the nearest one before it in Paseo\'s list that asks.',
    ]);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished' });
    expect(received().map((create) => create.config)).toEqual([expect.objectContaining({ provider: 'claude', model: 'claude-opus-5-5', modeId: 'bypassPermissions' })]);
  });

  it('starts a tool in a mode that asks when its mode option names one, over Paseo\'s default, and reports no permissions', async () => {
    behave({ output: { ok: true } });
    const runtime = start();
    const init = await ready(runtime, { options: { url: daemon.url, mode: { claude: 'plan' } } });

    expect(init).toMatchObject({ type: 'init', ok: true });
    expect(init).not.toHaveProperty('permissions');
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished' });
    expect(received().map((create) => create.config)).toEqual([expect.objectContaining({ provider: 'claude', model: 'claude-opus-5-5', modeId: 'plan' })]);
  });

  it('does not offer a tool whose mode option names a mode Paseo does not list for it, saying which it lists', async () => {
    behave({ models: { claude: ['claude-opus-5-5'], opencode: ['opencode/beam-free'] } });

    expect(await ready(start(), { options: { url: daemon.url, mode: { claude: 'yolo' } } })).toMatchObject({
      type: 'init', ok: true, can: { tools: ['opencode'] },
      unavailable: { claude: cannotRun('claude', 'the runtime\'s mode option names yolo for it, which Paseo does not list for claude (plan, default, acceptEdits, auto, bypassPermissions); name one of those') },
    });
  });

  it('does not offer a tool whose Paseo default mode is not one Paseo lists for it, saying so, and creates no agent', async () => {
    behave({ models: { claude: ['claude-opus-5-5'], opencode: ['opencode/beam-free'] }, default_modes: { claude: 'gone' } });
    const runtime = start();

    expect(await ready(runtime)).toMatchObject({ ok: true, can: { tools: ['opencode'] } });
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({
      event: 'failed',
      failure: { code: 'tool_unavailable', message: 'teamai-runtime-paseo did not offer claude: Paseo sets its default mode to gone, which it does not list for claude (plan, default, acceptEdits, auto, bypassPermissions); run `paseo provider ls` on the daemon\'s host to see its modes.' },
    });
    expect(received()).toEqual([]);
  });

  it('refuses a step on a tool it did not offer, saying why, and creates no agent', async () => {
    behave({ models: { claude: ['claude-opus-5-5'], codex: ['gpt-6.1-sol'] }, codex_login: 'signed_out' });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { tool: 'codex', model: undefined }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({
      event: 'failed', failure: { code: 'tool_unavailable', message: 'teamai-runtime-paseo did not offer codex: signed out; run `codex login` on the daemon\'s host.' },
    });
    expect(received()).toEqual([]);
  });

  it('offers a judge for the tools the daemon signs in, though teamai gives it no credential or login', async () => {
    behave({ models: { claude: ['claude-opus-5-5'] } });
    const runtime = start();

    // teamai refuses a credential or a login for a runtime that launches agents its own way, so this is what it sends.
    runtime.send({ type: 'init', protocol: 1, mode: 'unattended', options: { url: daemon.url }, credentials: { env: [], logins: [] }, homeEnv: SHIPPED_HOME_ENV });

    expect(await runtime.next(isInit)).toMatchObject({ ok: true, confinedPrompt: true, can: { tools: ['claude'], confined: [{ level: 'best-effort', access: 'read', tools: ['claude'] }] } });
  });
});
