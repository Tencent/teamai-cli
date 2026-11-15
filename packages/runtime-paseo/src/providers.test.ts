import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeMessage, RuntimeOptions } from '@teamai/runtime-protocol';
import { describe, expect, it } from 'vitest';
import { daemonRuns } from './providers.js';
import { type Behaviour } from './testing/fake-daemon.js';
import { type Runtime } from './testing/harness.js';
import { dir, daemonState, daemon, ATTEMPT, behave, received, start, isOp, isEnd, ready, openRequest, opened, delay, cannotRun, until, promptRequest, useRuntimeSuite, type PassedInstance } from './testing/suite.js';

describe('teamai-runtime-paseo', () => {
  useRuntimeSuite();

  describe('a team tool instance', () => {
    const ACME: PassedInstance = { name: 'acme-claude', tool: 'claude', command: 'acme-claude', home: { dir: '.claude-acme' }, homeEnv: ['CLAUDE_CONFIG_DIR'] };

    it('runs a step on an instance through the Paseo custom provider whose command is the instance\'s, in its base tool\'s mode and grants, and names the instance as the session\'s tool', async () => {
      behave({ output: { ok: true }, custom_providers: { 'claude-acme': { extends: 'claude', command: ['/opt/acme/bin/acme-claude'] } } });
      const runtime = start();

      expect(await ready(runtime, { instances: [ACME, { name: 'acme-cursor', tool: 'cursor', command: 'acme-cursor', homeEnv: [] }] })).toMatchObject({
        type: 'init', ok: true, can: { tools: ['claude', 'opencode', 'acme-claude'] },
      });
      const handle = await opened(runtime);
      runtime.send(promptRequest(handle, 'op-0000000b', { tool: 'acme-claude' }));

      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'acme-claude' }, result: { output: { ok: true } } });
      expect(received()).toMatchObject([{
        config: { provider: 'claude-acme', model: 'claude-opus-5-5', modeId: 'auto', providerOptions: { allowedTools: [`Edit(/${path.join(dir, 'out')}/**)`, `Edit(/${path.join(dir, 'run')}/**)`] } },
      }]);
    });

    it.each([
      ['no Paseo provider runs its command, and teamai finds no acme-claude on PATH to add one with', {}, {}, 'no Paseo provider runs its command acme-claude, and teamai adds one only for a command on its PATH; install acme-claude there, or name a Paseo provider that runs it in the runtime\'s providers option'],
      ['the only Paseo provider that names its command does so under ~/, which Paseo does not expand', { stale: { extends: 'claude', command: ['~/bin/acme-claude'] } }, {}, 'no Paseo provider runs its command acme-claude, and teamai adds one only for a command on its PATH; install acme-claude there, or name a Paseo provider that runs it in the runtime\'s providers option'],
      ['a Paseo provider of its name runs another command', { 'acme-claude': { extends: 'claude', command: ['claude'] } }, {}, 'no Paseo provider runs its command acme-claude, and the Paseo provider acme-claude runs claude instead, so teamai adds none under that name; point that provider at acme-claude, or name the provider to use in the runtime\'s providers option'],
      ['two Paseo providers run its command', { a: { extends: 'claude', command: ['acme-claude'] }, b: { extends: 'claude', command: ['/usr/local/bin/acme-claude'] } }, {}, 'Paseo providers a and b both run its command acme-claude; name the one to use in the runtime\'s providers option, such as providers: { acme-claude: a }'],
      ['the provider the providers option names does not extend its tool', { a: { extends: 'codex', command: ['acme-claude'] } }, { providers: { 'acme-claude': 'a' } }, 'the runtime\'s providers option names a, which the daemon\'s agents.providers does not hold as a provider that extends claude'],
      ['the provider the providers option names runs another command', { a: { extends: 'claude', command: ['claude'] } }, { providers: { 'acme-claude': 'a' } }, 'the runtime\'s providers option names a, which runs claude rather than its command acme-claude; name a provider whose command is acme-claude'],
    ] satisfies Array<[string, NonNullable<Behaviour['custom_providers']>, RuntimeOptions, string]>)('does not offer an instance when %s, naming how to set one up, and still offers the rest', async (_case, custom, options, reason) => {
      behave({ custom_providers: custom });

      expect(await ready(start(), { options: { url: daemon.url, ...options }, instances: [ACME] })).toMatchObject({
        type: 'init', ok: true, can: { tools: ['claude', 'opencode'] }, unavailable: { 'acme-claude': cannotRun('acme-claude', reason) },
      });
    });

    it.each([
      ['a Windows path with its extension', 'C:\\Tools\\acme\\acme-claude.EXE'],
      ['a Windows path written with forward slashes', 'D:/acme/acme-claude.cmd'],
      ['a bare Windows name', 'acme-claude.exe'],
    ])('offers an instance whose Paseo provider runs its command as a daemon on a Windows host writes it: %s', async (_case, command) => {
      behave({ custom_providers: { 'claude-acme': { extends: 'claude', command: [command] } } });

      expect(await ready(start(), { options: { url: daemon.url }, instances: [ACME] })).toMatchObject({ type: 'init', ok: true, can: { tools: ['claude', 'opencode', 'acme-claude'] } });
    });

    it.each([
      ['a daemon on this Windows machine, a bare name in another case', 'Acme-Claude', 'win32', true],
      ['a daemon elsewhere, a bare name in another case, which says nothing of its host', 'Acme-Claude', undefined, false],
      ['a daemon on this Linux machine, a bare name in another case', 'Acme-Claude', 'linux', false],
    ] satisfies Array<[string, string, NodeJS.Platform | undefined, boolean]>)('matches a provider command with the platform of the daemon\'s host where it is known: %s', (_case, executable, hostPlatform, runs) => {
      expect(daemonRuns({ executable, command: 'acme-claude', hostPlatform })).toBe(runs);
    });

    /** `name` as an executable on the runtime's PATH, as a member installs a team tool, and the env a runtime finds it with. */
    const installed = (name: string): { file: string; env: Record<string, string> } => {
      const bin = path.join(dir, 'bin');
      const file = path.join(bin, name);
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(file, '#!/bin/sh\nexec claude "$@"\n', { mode: 0o755 });

      return { file, env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, PASEO_HOME: path.join(dir, 'paseo') } };
    };

    const notices = (runtime: Runtime): RuntimeMessage[] => runtime.lines.filter((line) => 'event' in line && line.event === 'notice');

    const configChanges = (): unknown[] => received().filter((request) => request.type === 'set_daemon_config_request');

    /** The custom providers the daemon keeps now, by id. */
    const customProviders = (): Record<string, unknown> => (JSON.parse(fs.readFileSync(path.join(daemonState, 'behaviour.json'), 'utf8')) as { custom_providers?: Record<string, unknown> }).custom_providers ?? {};

    it('offers an instance no provider runs, adds a Paseo provider named after it at the first open that runs it, extending its tool and running its command from PATH in its own home, says so once, runs its steps there, and reuses it in a later run without adding it again', async () => {
      const { file, env } = installed('acme-claude');
      const home = path.join(dir, 'home', '.claude-acme');
      behave({ output: { ok: true } });
      const runtime = start(env);

      expect(await ready(runtime, { instances: [ACME] })).toMatchObject({ type: 'init', ok: true, can: { tools: ['claude', 'opencode', 'acme-claude'] } });
      expect(configChanges()).toEqual([]);
      const handle = await opened(runtime, { tool: 'acme-claude' });

      expect(notices(runtime)).toEqual([{
        event: 'notice', op: 'op-0000000a',
        message: `teamai added the Paseo provider acme-claude to the daemon at ${daemon.url} for its acme-claude steps: it extends claude and runs ${file}, with CLAUDE_CONFIG_DIR=${home}. It stays for later runs; to remove it, choose Remove provider on acme-claude in the Paseo app's provider settings, or delete agents.providers.acme-claude from ${path.join(dir, 'paseo', 'config.json')}, then run \`paseo daemon reload --home ${path.join(dir, 'paseo')}\`. Paseo cannot show its agents' logs once it is gone, so read them first.`,
      }]);
      runtime.send(promptRequest(handle, 'op-0000000b', { tool: 'acme-claude' }));

      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'acme-claude', home }, result: { output: { ok: true } } });
      expect(received()).toMatchObject([
        { type: 'set_daemon_config_request', config: { providers: { 'acme-claude': { extends: 'claude', label: 'acme-claude', command: [file], env: { CLAUDE_CONFIG_DIR: home } } } } },
        { type: 'agent.create.request', config: { provider: 'acme-claude', modeId: 'auto' } },
      ]);

      const later = start(env);

      expect(await ready(later, { mode: 'attended', instances: [ACME] })).toMatchObject({ type: 'init', ok: true, can: { tools: ['claude', 'opencode', 'acme-claude'] } });
      await opened(later, { attempt: 'a0123abce', tool: 'acme-claude' });
      expect(notices(later)).toEqual([]);
      expect(configChanges()).toHaveLength(1);
    });

    // describe sends `check` from a Paseo agent to ask whether a run could start there now, and opens nothing after it.
    it('answers a check with the tools it runs, adding no provider for an instance that needs one and saying nothing', async () => {
      const { env } = installed('acme-claude');
      behave({ output: { ok: true } });
      const runtime = start(env);

      expect(await ready(runtime, { mode: 'check', instances: [ACME] })).toMatchObject({ type: 'init', ok: true, prompt: true, can: { tools: ['claude', 'codex', 'opencode', 'acme-claude'], hitl: false } });
      expect(received()).toEqual([]);
      expect(customProviders()).toEqual({});
      expect(notices(runtime)).toEqual([]);
    });

    it('adds a provider once when two runtimes open the same instance together, setting no home for an instance with none of its own', async () => {
      const { file, env } = installed('acme-claude');
      const plain: PassedInstance = { name: 'acme-claude', tool: 'claude', command: 'acme-claude', homeEnv: ['CLAUDE_CONFIG_DIR'] };
      behave({ config_ms: 500 });
      const [first, second] = [start(env), start(env)];

      for (const runtime of [first, second]) expect(await ready(runtime, { instances: [plain] })).toMatchObject({ can: { tools: ['claude', 'opencode', 'acme-claude'] } });
      first.send(openRequest('op-0000000a', ATTEMPT, 'acme-claude'));
      second.send(openRequest('op-0000000c', 'a0123abce', 'acme-claude'));

      expect(await first.next(isOp('op-0000000a', 'ready'))).toMatchObject({ event: 'ready' });
      expect(await second.next(isOp('op-0000000c', 'ready'))).toMatchObject({ event: 'ready' });
      expect(configChanges()).toEqual([{ type: 'set_daemon_config_request', requestId: expect.any(String), config: { providers: { 'acme-claude': { extends: 'claude', label: 'acme-claude', command: [file] } } } }]);
      expect([...notices(first), ...notices(second)]).toHaveLength(1);
    });

    it('adds a provider once when another runtime opens an instance while this one adds two at once', async () => {
      const { file, env } = installed('acme-claude');
      installed('beta-claude');
      const acme: PassedInstance = { name: 'acme-claude', tool: 'claude', command: 'acme-claude', homeEnv: ['CLAUDE_CONFIG_DIR'] };
      const beta: PassedInstance = { name: 'beta-claude', tool: 'claude', command: 'beta-claude', homeEnv: ['CLAUDE_CONFIG_DIR'] };
      // acme-claude's add takes long; beta-claude's, which this runtime starts while it adds acme-claude, does not.
      behave({ provider_config_ms: { 'acme-claude': 1500 } });
      const [first, second] = [start(env), start(env)];

      for (const runtime of [first, second]) expect(await ready(runtime, { instances: [acme, beta] })).toMatchObject({ can: { tools: ['claude', 'opencode', 'acme-claude', 'beta-claude'] } });
      first.send(openRequest('op-0000000a', ATTEMPT, 'acme-claude'));
      await until(() => configChanges().length === 1);
      first.send(openRequest('op-0000000b', 'a0123abce', 'beta-claude'));
      await delay(200);
      second.send(openRequest('op-0000000c', 'a0123abcf', 'acme-claude'));

      for (const [runtime, op] of [[first, 'op-0000000a'], [first, 'op-0000000b'], [second, 'op-0000000c']] as const) expect(await runtime.next(isOp(op, 'ready'))).toMatchObject({ event: 'ready' });
      expect(configChanges()).toEqual([
        expect.objectContaining({ config: { providers: { 'acme-claude': { extends: 'claude', label: 'acme-claude', command: [file] } } } }),
        expect.objectContaining({ config: { providers: { 'beta-claude': { extends: 'claude', label: 'beta-claude', command: [path.join(dir, 'bin', 'beta-claude')] } } } }),
      ]);
      expect(notices(second)).toEqual([]);
    });

    it('adds a provider that runs its tool\'s own command in its own home for an instance with only a home of its own, and runs on one already there that does', async () => {
      const work: PassedInstance = { name: 'claude-work', tool: 'claude', home: { dir: '.claude-work' }, homeEnv: ['CLAUDE_CONFIG_DIR'] };
      const home = path.join(dir, 'home', '.claude-work');
      behave({ output: { ok: true } });
      const runtime = start({ PASEO_HOME: path.join(dir, 'paseo') });

      expect(await ready(runtime, { instances: [work] })).toMatchObject({ can: { tools: ['claude', 'opencode', 'claude-work'] } });
      runtime.send(promptRequest(await opened(runtime, { tool: 'claude-work' }), 'op-0000000b', { tool: 'claude-work' }));

      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'claude-work', home } });
      expect(received()).toMatchObject([
        { type: 'set_daemon_config_request', config: { providers: { 'claude-work': { extends: 'claude', label: 'claude-work', env: { CLAUDE_CONFIG_DIR: home } } } } },
        { type: 'agent.create.request', config: { provider: 'claude-work' } },
      ]);
      expect(notices(runtime)).toMatchObject([{ message: expect.stringContaining('it extends claude and runs claude\'s own command, with CLAUDE_CONFIG_DIR=') }]);

      behave({ output: { ok: true }, custom_providers: { work: { extends: 'claude', label: 'work', env: { CLAUDE_CONFIG_DIR: home } } } });
      const other = start();
      await ready(other, { instances: [work] });
      other.send(promptRequest(await opened(other, { attempt: 'a0123abce', op: 'op-0000000c', tool: 'claude-work' }), 'op-0000000d', { tool: 'claude-work' }));

      expect(await other.next(isEnd('op-0000000d'))).toMatchObject({ event: 'finished' });
      expect(received().at(-1)).toMatchObject({ type: 'agent.create.request', config: { provider: 'work' } });
      expect(configChanges()).toHaveLength(1);
    });

    // teamai resolves an instance's home once, the member's CLAUDE_CONFIG_DIR included, and the runtime uses it as given.
    it('adds the provider of an instance with only a home of its own in the home teamai resolved for it, wherever that is', async () => {
      const moved = path.join(dir, 'moved', 'claude-work-home');
      const work: PassedInstance = { name: 'claude-work', tool: 'claude', home: { dir: moved }, homeEnv: ['CLAUDE_CONFIG_DIR'] };
      behave({ output: { ok: true } });
      const runtime = start({ PASEO_HOME: path.join(dir, 'paseo') });

      await ready(runtime, { instances: [work] });
      runtime.send(promptRequest(await opened(runtime, { tool: 'claude-work' }), 'op-0000000b', { tool: 'claude-work' }));

      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'claude-work', home: moved } });
      expect(configChanges()).toMatchObject([{ config: { providers: { 'claude-work': { extends: 'claude', env: { CLAUDE_CONFIG_DIR: moved } } } } }]);
      expect(notices(runtime)).toMatchObject([{ message: expect.stringContaining(`with CLAUDE_CONFIG_DIR=${moved}`) }]);
    });

    it('accepts a prompt on an instance no open added a provider for before it adds that provider, and runs the prompt on it', async () => {
      const { file, env } = installed('acme-claude');
      behave({ output: { ok: true }, config_ms: 500 });
      const runtime = start(env);

      await ready(runtime, { instances: [ACME] });
      runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { tool: 'acme-claude' }));

      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'acme-claude' } });
      expect(runtime.lines.flatMap((line) => ('event' in line && 'op' in line && line.op === 'op-0000000b' ? [line.event] : []))).toEqual(['accepted', 'notice', 'display', 'finished']);
      expect(received()).toMatchObject([
        { type: 'set_daemon_config_request', config: { providers: { 'acme-claude': { command: [file] } } } },
        { type: 'agent.create.request', config: { provider: 'acme-claude' } },
      ]);
    });

    it('fails the open of an instance whose added provider is signed out, naming its sign-in step, and removes the provider it added, which no agent ran on', async () => {
      const work: PassedInstance = { name: 'claude-work', tool: 'claude', home: { dir: '.claude-work' }, homeEnv: ['CLAUDE_CONFIG_DIR'] };
      behave({ sign_in: { 'claude-work': 'signed_out' } });
      const runtime = start({ PASEO_HOME: path.join(dir, 'paseo') });
      await ready(runtime, { instances: [work] });
      runtime.send(openRequest('op-0000000a', ATTEMPT, 'claude-work'));

      expect(await runtime.next(isEnd('op-0000000a'))).toEqual({
        op: 'op-0000000a', event: 'failed',
        failure: { code: 'tool_unavailable', message: `teamai-runtime-paseo cannot run claude-work on the Paseo daemon at ${daemon.url}: signed out; run \`CLAUDE_CONFIG_DIR=~/.claude-work claude auth login\` on the daemon's host. Then run the step again.` },
      });
      expect(configChanges()).toEqual([
        expect.objectContaining({ config: { providers: { 'claude-work': expect.objectContaining({ extends: 'claude' }) } } }),
        expect.objectContaining({ config: { removeProviders: ['claude-work'] } }),
      ]);
      expect(customProviders()).not.toHaveProperty('claude-work');
      expect(notices(runtime)).toEqual([]);
    });

    it('fails the open of a Codex instance whose own home does not exist yet as signed out, naming the step that makes it and signs in there, and removes the provider it added', async () => {
      const work: PassedInstance = { name: 'codex-work', tool: 'codex', home: { dir: '.codex-work' }, homeEnv: ['CODEX_HOME'] };
      behave({ codex_login: 'signed_out', codex_needs_home: true });
      const runtime = start({ PASEO_HOME: path.join(dir, 'paseo'), CODEX_HOME: undefined });
      await ready(runtime, { instances: [work] });
      runtime.send(openRequest('op-0000000a', ATTEMPT, 'codex-work'));

      expect(await runtime.next(isEnd('op-0000000a'))).toEqual({
        op: 'op-0000000a', event: 'failed',
        failure: { code: 'tool_unavailable', message: `teamai-runtime-paseo cannot run codex-work on the Paseo daemon at ${daemon.url}: signed out, as its home ~/.codex-work does not exist yet; run \`mkdir -p ~/.codex-work && CODEX_HOME=~/.codex-work codex login\` on the daemon's host. Then run the step again.` },
      });
      expect(customProviders()).not.toHaveProperty('codex-work');
      expect(notices(runtime)).toEqual([]);
    });

    // A team Codex build may read its home from its own variable only; teamai names every variable the command reads.
    it('adds the provider of an instance whose build reads its own home variable with every home variable teamai gives it, and checks its sign-in with them', async () => {
      const work: PassedInstance = { name: 'codex-work', tool: 'codex', home: { dir: '.codex-work' }, homeEnv: ['CODEX_HOME', 'CODEX_WORK_HOME'] };
      const home = path.join(dir, 'home', '.codex-work');
      fs.mkdirSync(home, { recursive: true });
      behave({ output: { ok: true }, codex_login: 'signed_in', codex_login_home: home, codex_needs_home: true });
      const runtime = start({ PASEO_HOME: path.join(dir, 'paseo'), CODEX_HOME: undefined });

      expect(await ready(runtime, { instances: [work] })).toMatchObject({ type: 'init', ok: true, can: { tools: expect.arrayContaining(['codex-work']) } });
      runtime.send(promptRequest(await opened(runtime, { tool: 'codex-work' }), 'op-0000000b', { tool: 'codex-work', model: undefined }));

      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'codex-work' } });
      expect(configChanges()).toMatchObject([{ config: { providers: { 'codex-work': { extends: 'codex', env: { CODEX_HOME: home, CODEX_WORK_HOME: home } } } } }]);
      expect(notices(runtime)).toMatchObject([{ message: expect.stringContaining(`with CODEX_HOME=${home}, with CODEX_WORK_HOME=${home}`) }]);
    });

    it('says once that the provider it added stays, and how to remove it, when Paseo refuses to remove it again for an instance that cannot run on it', async () => {
      const work: PassedInstance = { name: 'claude-work', tool: 'claude', home: { dir: '.claude-work' }, homeEnv: ['CLAUDE_CONFIG_DIR'] };
      behave({ sign_in: { 'claude-work': 'signed_out' }, refuse_remove: 'The daemon config is read-only' });
      const runtime = start({ PASEO_HOME: path.join(dir, 'paseo') });
      await ready(runtime, { instances: [work] });
      runtime.send(openRequest('op-0000000a', ATTEMPT, 'claude-work'));

      expect(await runtime.next(isEnd('op-0000000a'))).toEqual({
        op: 'op-0000000a', event: 'failed',
        failure: { code: 'tool_unavailable', message: `teamai-runtime-paseo cannot run claude-work on the Paseo daemon at ${daemon.url}: signed out; run \`CLAUDE_CONFIG_DIR=~/.claude-work claude auth login\` on the daemon's host. teamai could not remove the provider claude-work it added for it (Request failed: The daemon config is read-only), so it may stay. Then run the step again.` },
      });
      expect(customProviders()).toHaveProperty('claude-work');
      expect(notices(runtime)).toMatchObject([{ op: 'op-0000000a', message: expect.stringContaining('teamai added the Paseo provider claude-work') }]);

      runtime.send(openRequest('op-0000000c', 'a0123abce', 'claude-work'));
      await runtime.next(isEnd('op-0000000c'));

      // The provider it kept is found again: nothing more is added or said.
      expect(configChanges().filter((change) => JSON.stringify(change).includes('"providers"'))).toHaveLength(1);
      expect(notices(runtime)).toHaveLength(1);
    });

    it('adds no provider on a daemon on another host, whose PATH teamai cannot see, and says how to add one there', async () => {
      const { env } = installed('acme-claude');
      // 0.0.0.0 reaches the fake on this machine, but names no loopback address, as a daemon on another host is named.
      const url = daemon.url.replace('127.0.0.1', '0.0.0.0');

      expect(await ready(start(env), { options: { url }, instances: [ACME] })).toMatchObject({
        type: 'init', ok: true,
        unavailable: { 'acme-claude': `The Paseo daemon at ${url} cannot run acme-claude: no Paseo provider runs its command acme-claude, and teamai adds one only on a daemon on this machine; add one on the daemon's host that extends claude with command ["acme-claude"] (\`paseo daemon config set agents.providers …\`, then \`paseo daemon reload\`), or name one in the runtime's providers option.` },
      });
    });

    it('adds no provider for an instance whose name Paseo takes for no provider, and says how to add one', async () => {
      const { env } = installed('acme.claude');

      expect(await ready(start(env), { instances: [{ ...ACME, name: 'acme.claude', command: 'acme.claude' }] })).toMatchObject({
        type: 'init', ok: true,
        unavailable: { 'acme.claude': cannotRun('acme.claude', 'no Paseo provider runs its command acme.claude, and teamai cannot add one named acme.claude, since Paseo names a provider with lowercase letters, digits and dashes only, starting with a letter; add one on the daemon\'s host that extends claude with command ["acme.claude"], and name it in the runtime\'s providers option') },
      });
    });

    it('ends a prompt cancelled at once, and closes its place, when the place closes while the prompt adds its instance\'s provider', async () => {
      const { env } = installed('acme-claude');
      behave({ output: { ok: true }, config_ms: 11000 });
      const runtime = start(env);
      await ready(runtime, { instances: [ACME] });
      const handle = await opened(runtime);
      runtime.send(promptRequest(handle, 'op-0000000b', { tool: 'acme-claude' }));
      await runtime.next(isOp('op-0000000b', 'accepted'));
      runtime.send({ type: 'close', handle });

      expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
      expect(await runtime.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
      expect(received().filter((request) => request.type === 'agent.create.request')).toEqual([]);
    });

    it('fails the open of an instance whose providers it cannot hold, naming the directory to make writable, and adds the provider at a later open once it can', async () => {
      const { file, env } = installed('acme-claude');
      const holds = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'providers');
      fs.mkdirSync(path.dirname(holds), { recursive: true });
      fs.writeFileSync(holds, 'not a directory');
      const runtime = start(env);
      await ready(runtime, { instances: [ACME] });
      runtime.send(openRequest('op-0000000a', ATTEMPT, 'acme-claude'));

      expect(await runtime.next(isEnd('op-0000000a'))).toMatchObject({ event: 'failed', failure: { code: 'tool_unavailable', message: expect.stringContaining('make that directory writable') } });

      fs.rmSync(holds);
      runtime.send(openRequest('op-0000000c', 'a0123abce', 'acme-claude'));

      expect(await runtime.next(isOp('op-0000000c', 'ready'))).toMatchObject({ event: 'ready' });
      expect(configChanges()).toMatchObject([{ config: { providers: { 'acme-claude': { command: [file] } } } }]);
    });

    it('fails the open of an instance whose provider Paseo refuses to add, naming Paseo\'s error and how to add one, and adds it at a later open once Paseo takes it', async () => {
      const { file, env } = installed('acme-claude');
      behave({ refuse_config: 'The daemon config is read-only' });
      const runtime = start(env);
      await ready(runtime, { instances: [ACME] });
      runtime.send(openRequest('op-0000000a', ATTEMPT, 'acme-claude'));

      expect(await runtime.next(isEnd('op-0000000a'))).toEqual({
        op: 'op-0000000a', event: 'failed',
        failure: { code: 'tool_unavailable', message: `teamai-runtime-paseo cannot run acme-claude on the Paseo daemon at ${daemon.url}: Paseo refused the provider acme-claude teamai added for it (Request failed: The daemon config is read-only); add one on the daemon's host that extends claude with command ${JSON.stringify([file])}, or name one in the runtime's providers option. Then run the step again.` },
      });

      behave({});
      runtime.send(openRequest('op-0000000c', 'a0123abce', 'acme-claude'));

      expect(await runtime.next(isOp('op-0000000c', 'ready'))).toMatchObject({ event: 'ready' });
      // The refused change, then the one Paseo took.
      expect(configChanges()).toMatchObject([{ config: { providers: { 'acme-claude': { command: [file] } } } }, { config: { providers: { 'acme-claude': { command: [file] } } } }]);
      expect(notices(runtime)).toMatchObject([{ op: 'op-0000000c' }]);
    });

    it('still offers its tools when Paseo fails to read its config, naming each instance and named provider unavailable with Paseo\'s error', async () => {
      behave({ refuse_config_read: 'config.json is locked', custom_providers: { 'codex-wrap': { extends: 'codex', command: ['codex-wrap'] } } });
      const why = 'Paseo did not answer with its providers (config.json is locked); run `paseo daemon config get agents.providers --json` on the daemon\'s host to see why';

      expect(await ready(start(), { options: { url: daemon.url, providers: { codex: 'codex-wrap' } }, instances: [ACME] })).toMatchObject({
        type: 'init', ok: true, can: { tools: ['claude', 'opencode'] },
        unavailable: { 'acme-claude': cannotRun('acme-claude', why), codex: cannotRun('codex', why) },
      });
    });

    it('still offers its tools when the providers option names an instance teamai did not pass, naming it under unavailable', async () => {
      behave({ custom_providers: { 'claude-acme': { extends: 'claude', command: ['acme-claude'] } } });

      expect(await ready(start(), { options: { url: daemon.url, providers: { 'acme-claude': 'claude-acme', cursor: 'x' } } })).toMatchObject({
        type: 'init', ok: true, can: { tools: ['claude', 'opencode'] },
        unavailable: {
          'acme-claude': cannotRun('acme-claude', 'the runtime\'s providers option names it, and teamai passed no tool instance acme-claude here; a team tool runs here once its command is accepted on this machine. If it is no team tool, remove acme-claude from the providers option'),
          cursor: cannotRun('cursor', 'the runtime\'s providers option names it, and teamai passed no tool instance cursor here; a team tool runs here once its command is accepted on this machine. If it is no team tool, remove cursor from the providers option'),
        },
      });
    });

    it('names an instance teamai passed whose tool Paseo does not run under unavailable, when the providers option names it', async () => {
      const codebuddy = { name: 'acme-codebuddy', tool: 'codebuddy', command: 'acme-codebuddy', homeEnv: [] };

      expect(await ready(start(), { options: { url: daemon.url, providers: { 'acme-codebuddy': 'x' } }, instances: [codebuddy] })).toMatchObject({
        type: 'init', ok: true, can: { tools: ['claude', 'opencode'] },
        unavailable: { 'acme-codebuddy': cannotRun('acme-codebuddy', 'it extends codebuddy, which Paseo does not run. Remove acme-codebuddy from the providers option') },
      });
    });

    it('runs an instance on the provider the providers option names, when two run its command', async () => {
      behave({ output: { ok: true }, custom_providers: { a: { extends: 'claude', command: ['acme-claude'] }, b: { extends: 'claude', command: ['acme-claude'] } } });
      const runtime = start();

      expect(await ready(runtime, { options: { url: daemon.url, providers: { 'acme-claude': 'b' } }, instances: [ACME] })).toMatchObject({ can: { tools: ['claude', 'opencode', 'acme-claude'] } });
      runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { tool: 'acme-claude' }));

      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished' });
      expect(received()).toMatchObject([{ config: { provider: 'b' } }]);
    });
  });

  it('checks the sign-in of a Codex instance in the instance\'s own Codex home', async () => {
    const acme: PassedInstance = { name: 'acme-codex', tool: 'codex', command: 'acme-codex', home: { dir: '.codex-acme' }, homeEnv: ['CODEX_HOME'] };
    behave({ codex_login: 'signed_in', codex_login_home: path.join(dir, 'home', '.codex-acme'), custom_providers: { 'codex-acme': { extends: 'codex', command: ['/opt/acme/bin/acme-codex'] } } });

    expect(await ready(start(), { instances: [acme] })).toMatchObject({
      type: 'init', ok: true, can: { tools: ['claude', 'opencode', 'acme-codex'] },
      unavailable: { codex: cannotRun('codex', 'signed out; run `codex login` on the daemon\'s host') },
    });
  });

  it('names the instance\'s own command and home in the sign-in step of an instance that is signed out', async () => {
    const acme: PassedInstance = { name: 'acme-codex', tool: 'codex', command: 'acme-codex', home: { dir: '.codex-acme' }, homeEnv: ['CODEX_HOME'] };
    behave({ codex_login: 'signed_out', sign_in: { 'claude-acme': 'signed_out' }, custom_providers: { 'codex-acme': { extends: 'codex', command: ['/opt/acme/bin/acme-codex'] }, 'claude-acme': { extends: 'claude', command: ['acme-claude'] } } });

    expect(await ready(start(), { instances: [acme, { name: 'acme-claude', tool: 'claude', command: 'acme-claude', homeEnv: ['CLAUDE_CONFIG_DIR'] }] })).toMatchObject({
      unavailable: {
        'acme-codex': cannotRun('acme-codex', 'signed out; run `CODEX_HOME=~/.codex-acme acme-codex login` on the daemon\'s host'),
        'acme-claude': cannotRun('acme-claude', 'signed out; run `acme-claude auth login` on the daemon\'s host'),
      },
    });
  });

  it('checks a Codex instance\'s sign-in, and finds its sessions, in the home its Paseo provider sets in its env, saying once that this is not teamai\'s home for it', async () => {
    const providerHome = path.join(dir, 'paseo-homes', 'acme-codex');
    const acme: PassedInstance = { name: 'acme-codex', tool: 'codex', command: 'acme-codex', home: { dir: '.codex-acme' }, homeEnv: ['CODEX_HOME'] };
    behave({
      output: { ok: true }, codex_login: 'signed_in', codex_login_home: providerHome, codex_home: providerHome,
      custom_providers: { 'codex-acme': { extends: 'codex', command: ['/opt/acme/bin/acme-codex'], env: { CODEX_HOME: providerHome, OPENAI_BASE_URL: 'https://llm.acme.example' } } },
    });
    const runtime = start();

    expect(await ready(runtime, { instances: [acme] })).toMatchObject({ type: 'init', ok: true, can: { tools: ['claude', 'opencode', 'acme-codex'] } });
    expect(runtime.lines.filter((line) => 'event' in line && line.event === 'notice')).toEqual([{
      event: 'notice',
      message: `Paseo provider codex-acme runs acme-codex with CODEX_HOME=${providerHome}, not teamai's home for it (${path.join(dir, 'home', '.codex-acme')}): its steps sign in and keep their sessions in ${providerHome}, where teamai reads them.`,
    }]);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { tool: 'acme-codex', model: undefined }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'acme-codex', home: providerHome } });
  });

  it('checks the sign-in of Codex on the custom provider the providers option names for it, through that provider\'s own command', async () => {
    behave({ codex_login: 'signed_in', custom_providers: { 'codex-wrap': { extends: 'codex', command: ['/opt/wrap/bin/codex-wrap'] } } });

    const init = await ready(start(), { options: { url: daemon.url, providers: { codex: 'codex-wrap' } } });

    expect(init).not.toHaveProperty('unavailable.codex');
    expect(init).toMatchObject({ type: 'init', ok: true, can: { tools: ['claude', 'codex', 'opencode'] } });
  });
});
