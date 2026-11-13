import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeMessageSchema, UNAVAILABLE_REASON_MAX } from '@teamai/runtime-protocol';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseYaml } from '@teamai/shared/yaml';
import { CLAUDE, CODEX, credentialsFile, fakeBrowser, PATH_WITHOUT_T3, signIn, type Connection, type FakeT3Config, type Line } from './testing/harness.js';
import { checkout, dir, noticesOf, SHIPPED_HOME_ENV, start, t3, useT3Runtime } from './testing/suite.js';

/** The `exec` teamai's own runtime `name` declares in its marker (`runtimes/teamai-<name>.yaml`), which teamai reads without starting it. */
function declaredExec(name: string): unknown {
  const marker = z.object({ exec: z.unknown() }).parse(parseYaml(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'runtimes', `teamai-${name}.yaml`), 'utf8')));

  return marker.exec;
}

describe('teamai-runtime-t3', () => {
  useT3Runtime();

  describe('init', () => {
    it('offers prompt steps for the tools the environment runs, reporting their tokens, and no command', async () => {
      signIn(t3);
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });
      const reply = await runtime.next((line) => line['type'] === 'init');

      expect(RuntimeMessageSchema.safeParse(reply).success).toBe(true);
      expect(reply).toEqual({
        type: 'init', ok: true, prompt: true, conversations: true, confinedPrompt: true, wake: true,
        can: {
          exec: false, setup: false, env: false, hitl: true, tokens: true, unattended: false, max_turns: false,
          workspace: ['read-only', 'new', 'continue', 'clone', 'team'], tools: ['claude', 'codex'],
          confined: [{ level: 'best-effort', access: 'read', tools: ['claude', 'codex'] }],
        },
      });
      // teamai skips the runtime for a run that needs no AI tool by what its manifest declares, never asking init.
      expect(declaredExec('t3')).toBe(z.object({ can: z.object({ exec: z.boolean() }) }).parse(reply).can.exec);
    });

    it.skipIf(process.platform === 'win32')('offers no tokens when teamai cannot list the folder a tool keeps its sessions in, so a budgeted step goes where its tokens are counted', async () => {
      signIn(t3);
      // Codex's store, made by another user T3 Code runs as.
      const store = path.join(t3.home, '.codex', 'sessions');
      fs.mkdirSync(store, { recursive: true });
      fs.chmodSync(store, 0o300);
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });

      try {
        expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, can: { tools: ['claude', 'codex'], tokens: false } });
      } finally {
        fs.chmodSync(store, 0o700);
      }
    });

    it.each([
      ['an older version', '0.1.7-nightly.20261103.4119', 'runs version 0.1.7-nightly.20261103.4119'],
      ['no version', undefined, 'did not say which version it runs'],
    ])('refuses a T3 Code that reports %s, naming the version it needs and the update', async (_, serverVersion, said) => {
      signIn(t3);
      t3.config({ environment: { environmentId: 'env-fake-1', label: 'fake-laptop', ...(serverVersion !== undefined && { serverVersion }) } });
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toEqual({
        type: 'init', ok: false,
        error: { code: 't3_version', message: `T3 Code ${said}; teamai-runtime-t3 needs T3 Code 0.1.8 or later. Update T3 Code, then start the workflow again.` },
      });
    });

    it('runs on a nightly of the oldest T3 Code it needs', async () => {
      signIn(t3);
      t3.config({ environment: { environmentId: 'env-fake-1', label: 'fake-laptop', serverVersion: '0.1.8-nightly.20261104.4200' } });
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ type: 'init', ok: true });
    });

    // The `t3` command on this machine creates a pairing code, and teamai approves its own sign-in with it, as T3's page would.
    it.each(['attended', 'unattended'] as const)('signs in with no page in an %s run, through a pairing code the t3 command creates, and keeps the credential to itself', async (mode) => {
      const browser = fakeBrowser(dir);
      const runtime = start({ PATH: [t3.bin, browser.bin, PATH_WITHOUT_T3].join(path.delimiter) });

      runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode, options: { environment: 'local' } });

      const reply = await runtime.next((line) => line['type'] === 'init');
      expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true, can: { tools: ['claude', 'codex'] } });
      expect(t3.commandRuns()).toEqual([[
        'auth', 'pairing', 'create', '--json', '--base-dir', t3.t3Home, '--scope', 'orchestration:read', '--scope', 'orchestration:operate', '--ttl', '2m', '--label', 'teamai workflow',
      ]]);
      expect(t3.calls().map((call) => call.tool).filter((tool) => tool.startsWith('oauth_'))).toEqual(['oauth_decision', 'oauth_token']);
      expect(t3.calls().find((call) => call.tool === 'oauth_decision')?.args).toEqual({ access: 'auto' });
      expect(browser.visits()).toEqual([]);
      expect(runtime.stderr()).toBe('');
      expect(fs.statSync(credentialsFile(t3.home)).mode & 0o777).toBe(0o600);
      await runtime.close();

      const later = start();
      later.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'unattended', options: { environment: 'local' } });

      expect(await later.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
      expect(t3.commandRuns()).toHaveLength(1);
      expect(t3.calls().filter((call) => call.tool === 'oauth_token')).toHaveLength(1);
    });

    it('refuses an environment other than local before it signs in, since a step\'s first message names this machine\'s paths', async () => {
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'unattended', options: { environment: 'gpu-box' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'environment',
        message: 'environment "gpu-box" is not one runtime t3 runs steps in. It launches a step\'s thread only in environment: local, the T3 Code on this machine, because the thread\'s first message names this machine\'s paths, such as the run\'s scratch directory and the workflow\'s folder, which a linked environment does not have. Set environment: local, or offer the step to another machine with a fleet entry whose wake uses t3' } });
      expect(t3.calls()).toEqual([]);
    });

    it.each(['auto-accept-edits', 'approval-required'])('approves its silent sign-in with Auto access in a run whose runtime_mode is %s', async (runtimeMode) => {
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'unattended', options: { environment: 'local', runtime_mode: runtimeMode } });

      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
      expect(t3.calls().find((call) => call.tool === 'oauth_decision')?.args).toEqual({ access: 'auto' });
    });

    it('signs in through T3\'s page in an attended run with no t3 command, keeps the credential to itself, and a later unattended run reuses it', async () => {
      const browser = fakeBrowser(dir);
      const attended = start({ PATH: `${browser.bin}${path.delimiter}${PATH_WITHOUT_T3}` });

      attended.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });

      const signedIn = await attended.next((line) => line['type'] === 'init');
      expect(signedIn, JSON.stringify(signedIn)).toMatchObject({ ok: true });
      expect(browser.visits()).toEqual(['/oauth/mcp/authorize']);
      // The page's link reaches the person while init waits, for a browser that did not open.
      expect(noticesOf(attended)).toEqual([{ event: 'notice', message: expect.stringMatching(/^Approve teamai in T3 Code \(silent sign-in failed: found no t3 command .*\)\. If no browser opened, visit: http:\/\/127\.0\.0\.1:\d+\/oauth\/mcp\/authorize\?\S+$/) }]);
      expect(attended.stderr()).toBe('');
      expect(fs.statSync(credentialsFile(t3.home)).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(credentialsFile(t3.home))).mode & 0o777).toBe(0o700);
      await attended.close();

      const unattended = start();
      unattended.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'unattended', options: { environment: 'local' } });

      expect(await unattended.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, can: { hitl: false } });
      expect(t3.calls().filter((call) => call.tool === 'oauth_token')).toHaveLength(1);
    });

    describe('when the silent sign-in fails', () => {
      const failures: Array<{ failure: string; path?: () => string; config?: Partial<FakeT3Config>; reason: string | (() => string) }> = [
        // It names the three places it looked, T3's own command first.
        { failure: 'there is no t3 command', path: () => PATH_WITHOUT_T3, reason: () => `found no t3 command at $T3CODE_CLI_PATH (unset), on PATH, or at ${path.join(t3.t3Home, 'bin', 't3')}` },
        { failure: 'the t3 command fails', config: { commandFails: 3 }, reason: 't3 auth pairing create exited with status 3: Could not reach the T3 Code server' },
        { failure: 'T3 refuses the pairing code', config: { decisionRefused: true }, reason: 'T3 Code refused the pairing code with HTTP 400: That pairing code is not valid. Create a new one and try again' },
        { failure: 'T3 redirects with no code', config: { decisionNoCode: true }, reason: 'T3 Code\'s sign-in redirect carried no code (access_denied)' },
        // teamai gives an unattended init 10 s, so a T3 Code that does not answer the sign-in fails it with the reason, well before.
        { failure: 'T3 does not answer the sign-in', config: { decisionMs: 30_000 }, reason: 'the silent sign-in did not finish within 8 s' },
      ];

      /** Every secret the sign-in handled: the pairing codes the t3 command created, and the token T3 issues. */
      const secrets = (): string[] => [...t3.pairingCodes(), 'fake-t3-token-0123456789'];

      it.each(failures)('fails an unattended run login_required, saying why, when $failure', { timeout: 30_000 }, async ({ path: pathOf, config, reason: reasonOf }) => {
        const reason = typeof reasonOf === 'string' ? reasonOf : reasonOf();
        if (config) t3.config(config);
        const runtime = start(pathOf ? { PATH: pathOf() } : {});

        runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'unattended', options: { environment: 'local' } });

        const reply = await runtime.next((line) => line['type'] === 'init', 20_000);
        expect(reply).toEqual({
          type: 'init', ok: false,
          error: {
            code: 'login_required',
            message: `teamai has no valid T3 Code sign-in for ${t3.origin()} and could not sign in through the t3 command (${reason}), and an unattended run cannot ask for one. Start any workflow with --driver t3 from a terminal on this machine once, approve teamai in the page T3 Code opens, then run this again.`,
          },
        });

        for (const secret of secrets()) expect(`${JSON.stringify(reply)}${runtime.stderr()}`).not.toContain(secret);
      });

      it.each(failures)('opens T3\'s page in an attended run, saying why, when $failure', { timeout: 30_000 }, async ({ path: pathOf, config, reason: reasonOf }) => {
        const reason = typeof reasonOf === 'string' ? reasonOf : reasonOf();
        if (config) t3.config(config);
        const browser = fakeBrowser(dir);
        const runtime = start({ PATH: [browser.bin, pathOf?.() ?? [t3.bin, PATH_WITHOUT_T3].join(path.delimiter)].join(path.delimiter) });

        runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });

        expect(await runtime.next((line) => line['type'] === 'init', 20_000)).toMatchObject({ ok: true });
        expect(browser.visits()).toEqual(['/oauth/mcp/authorize']);
        const said = `Approve teamai in T3 Code (silent sign-in failed: ${reason}). If no browser opened, visit: `;
        const [notice, ...more] = noticesOf(runtime);
        expect(more).toEqual([]);
        const message = z.string().parse(notice?.['message']);
        expect(message.slice(0, said.length)).toBe(said);
        expect(message.slice(said.length)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/mcp\/authorize\?\S+$/);
        expect(runtime.stderr()).toBe('');

        for (const secret of secrets()) expect(message).not.toContain(secret);
      });
    });

    it('fails an unattended run with no sign-in and no t3 command, saying how to sign in, and asks T3 for none', async () => {
      const runtime = start({ PATH: PATH_WITHOUT_T3 });

      runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'unattended', options: { environment: 'local' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toEqual({
        type: 'init', ok: false,
        error: { code: 'login_required', message: expect.stringContaining('Start any workflow with --driver t3 from a terminal on this machine once') },
      });
      expect(t3.calls()).toEqual([]);
    });

    // teamai opens a runtime in recover mode only to stop and close what it recorded, so a stop works whatever the sign-in.
    it('opens in recover mode with no sign-in, asking T3 nothing and offering nothing', async () => {
      const browser = fakeBrowser(dir);
      const runtime = start({ PATH: [t3.bin, browser.bin, PATH_WITHOUT_T3].join(path.delimiter) });

      runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'recover', options: { environment: 'local' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toEqual({ type: 'init', ok: true, can: {} });
      expect(browser.visits()).toEqual([]);
      expect(t3.calls()).toEqual([]);
      expect(t3.commandRuns()).toEqual([]);
    });

    // describe sends `check` from a T3 thread to ask whether a run could start there now, and opens nothing after it.
    describe('in check mode', () => {
      const couldStart = { type: 'init', ok: true, prompt: true, conversations: true, can: { exec: false, env: false } };
      const check = (runtime: Connection): void => runtime.send({
        type: 'init', protocol: 1, mode: 'check', options: { environment: 'local' }, instances: [{ name: 'acme-claude', tool: 'claude', command: path.join(dir, 'acme-claude') }], homeEnv: { ...SHIPPED_HOME_ENV, 'acme-claude': ['CLAUDE_CONFIG_DIR'] },
      });

      it('answers that a run could start on the sign-in it keeps, asking T3 nothing and writing none of its settings', async () => {
        signIn(t3);
        t3.settings({ providerInstances: {} });
        const settings = path.join(t3.t3Home, 'userdata', 'settings.json');
        const before = fs.readFileSync(settings);
        const runtime = start();

        check(runtime);

        expect(await runtime.next((line) => line['type'] === 'init')).toEqual(couldStart);
        expect(t3.calls()).toEqual([]);
        expect(t3.commandRuns()).toEqual([]);
        expect(fs.readFileSync(settings).equals(before)).toBe(true);
      });

      it('answers that a run could start with no sign-in kept when there is a t3 command to sign in with, and runs it never', async () => {
        const runtime = start();

        check(runtime);

        expect(await runtime.next((line) => line['type'] === 'init')).toEqual(couldStart);
        expect(t3.commandRuns()).toEqual([]);
        expect(t3.pairingCodes()).toEqual([]);
        expect(fs.existsSync(credentialsFile(t3.home))).toBe(false);
      });

      it('fails login_required, saying how to sign in, with no sign-in kept and no t3 command', async () => {
        const runtime = start({ PATH: PATH_WITHOUT_T3 });

        check(runtime);

        expect(await runtime.next((line) => line['type'] === 'init')).toEqual({
          type: 'init', ok: false,
          error: { code: 'login_required', message: expect.stringContaining('Start any workflow with --driver t3 from a terminal on this machine once') },
        });
        expect(t3.calls()).toEqual([]);
      });

      it('fails t3_unavailable when T3 Code is not running', async () => {
        signIn(t3);
        await t3.stop();
        fs.rmSync(path.join(t3.t3Home, 'userdata', 'server-runtime.json'));
        const runtime = start();

        check(runtime);

        expect(await runtime.next((line) => line['type'] === 'init')).toEqual({
          type: 'init', ok: false, error: { code: 't3_unavailable', message: 'T3 Code is not running on this machine. Open T3 Code, or run `t3 serve`, then start the workflow again.' },
        });
      });
    });

    // T3 issues no refresh token, so a credential about to expire is replaced by signing in again.
    it('signs in again with no page when its sign-in has expired, in an unattended run, and keeps the new credential', async () => {
      signIn(t3, 'fake-t3-token-expired-0000000000', 60);
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'unattended', options: { environment: 'local' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
      expect(t3.commandRuns()).toHaveLength(1);
      expect(t3.calls().filter((call) => call.tool === 'oauth_token')).toHaveLength(1);
      const kept = fs.readFileSync(credentialsFile(t3.home), 'utf8');
      expect(kept).not.toContain('fake-t3-token-expired-0000000000');
      expect(kept).toContain('fake-t3-token-0123456789');
      expect(fs.statSync(credentialsFile(t3.home)).mode & 0o777).toBe(0o600);
    });

    it('fails an unattended run whose sign-in has expired login_required, saying why it could not sign in again', async () => {
      signIn(t3, undefined, 60);
      const runtime = start({ PATH: PATH_WITHOUT_T3 });

      runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'unattended', options: { environment: 'local' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({
        ok: false, error: { code: 'login_required', message: expect.stringContaining('could not sign in through the t3 command (found no t3 command at $T3CODE_CLI_PATH (unset), on PATH, or at ') },
      });
    });

    // teamai gives init 15 s, so a T3 Code that does not answer fails init well before, saying so.
    it('fails init t3_unavailable within its bound when T3 Code does not answer what it runs', async () => {
      signIn(t3);
      t3.config({ environmentMs: 30_000 });
      const runtime = start();
      const sentAt = Date.now();

      runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'unattended', options: { environment: 'local' } });

      expect(await runtime.next((line) => line['type'] === 'init', 20_000)).toEqual({ type: 'init', ok: false, error: { code: 't3_unavailable', message: 'T3 Code did not answer what it runs within 10 s. Check that T3 Code is open and responding, then start the workflow again.' } });
      expect(Date.now() - sentAt).toBeLessThan(12_000);
    }, 30_000);

    it('fails when T3 Code is not running, saying to open it or run t3 serve', async () => {
      signIn(t3);
      await t3.stop();
      fs.rmSync(path.join(t3.t3Home, 'userdata', 'server-runtime.json'));
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: false, error: { code: 't3_unavailable', message: 'T3 Code is not running on this machine. Open T3 Code, or run `t3 serve`, then start the workflow again.' } });
    });

    // A server file outlives a server that crashed or is stopping.
    it('fails t3_unavailable, naming t3 serve, when the server its file names does not answer', async () => {
      signIn(t3);
      const origin = t3.origin();
      await t3.stop();
      fs.writeFileSync(path.join(t3.t3Home, 'userdata', 'server-runtime.json'), JSON.stringify({ version: 1, pid: 999_999, origin }));
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'unattended', options: { environment: 'local' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toEqual({
        type: 'init', ok: false, error: { code: 't3_unavailable', message: `T3 Code at ${origin} does not answer. Open T3 Code, or run \`t3 serve\`, then start the workflow again.` },
      });
    });

    describe('with no t3 command on PATH', () => {
      /** T3's own command, where T3 installs it in its data directory. */
      const installed = (): string => {
        const command = path.join(t3.t3Home, 'bin', 't3');
        fs.mkdirSync(path.dirname(command), { recursive: true });
        fs.copyFileSync(path.join(t3.bin, 't3'), command);
        fs.chmodSync(command, 0o755);

        return command;
      };

      // T3 sets T3CODE_CLI_PATH and no T3CODE_HOME in its threads; a T3 home other than ~/.t3 is found through the command's path.
      it('signs in through the t3 command T3CODE_CLI_PATH names, in the T3 home that holds it', async () => {
        const runtime = start({ PATH: PATH_WITHOUT_T3, T3CODE_HOME: '', T3CODE_CLI_PATH: installed() });

        runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'unattended', options: { environment: 'local' } });

        expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
        expect(t3.commandRuns()).toEqual([expect.arrayContaining(['auth', 'pairing', 'create', '--base-dir', t3.t3Home])]);
      });

      it('signs in through the t3 command in the T3 home', async () => {
        installed();
        const runtime = start({ PATH: PATH_WITHOUT_T3 });

        runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'unattended', options: { environment: 'local' } });

        expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
        expect(t3.commandRuns()).toHaveLength(1);
      });
    });

    it('runs every prompt on the provider instance `instance` names, and fails naming the setup step for one T3 lacks', async () => {
      signIn(t3);
      t3.config({ providers: [CLAUDE, { ...CLAUDE, providerInstanceId: 'claude-work', displayName: 'Claude (work)' }, { ...CLAUDE, providerInstanceId: 'claude-off', constraints: ['Provider instance is disabled.'] }] });
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local', instance: 'claude-work' } });
      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, can: { tools: ['claude'] } });

      const missing = start();
      missing.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local', instance: 'claude-sandbox' } });
      expect(await missing.next((line) => line['type'] === 'init')).toEqual({
        type: 'init', ok: false,
        error: { code: 'bad_option', key: 'instance', message: expect.stringMatching(/^T3 Code has no provider instance "claude-sandbox"\. Add it in T3 Code under Settings → Providers, .*Instances here: [^.]+$/) },
      });

      const disabled = start();
      disabled.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local', instance: 'claude-off' } });
      expect(await disabled.next((line) => line['type'] === 'init')).toMatchObject({ ok: false, error: { key: 'instance', message: expect.stringMatching(/cannot run now: Provider instance is disabled\. Enable it in T3 Code under Settings → Providers$/) } });
    });

    // T3 Code 0.1.8 lists a signed-out Claude or Codex with these constraints, so neither is offered to run or to judge.
    it('offers no tool whose provider T3 reports as signed out', async () => {
      signIn(t3);
      t3.config({ providers: [{ ...CLAUDE, constraints: ['Claude Code is not authenticated. Run `claude auth login` and try again.', 'Provider is not authenticated.'] }, CODEX] });
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, can: { tools: ['codex'], confined: [{ tools: ['codex'] }] } });
    });

    describe('the default tool', () => {
      const CODEX_DEFAULT = { instanceId: 'codex', model: 'gpt-6.1-sol' };

      it.each<{ set: string; settings: Line; providers?: FakeT3Config['providers']; options?: Line; tool: string | undefined }>([
        { set: 'the member\'s T3 default runs on an offered instance', settings: { defaultModelSelection: CODEX_DEFAULT }, tool: 'codex' },
        { set: 'the checkout\'s project sets its own default, over the global one', settings: { defaultModelSelection: CODEX_DEFAULT, projectSettingsOverrides: { 'project-1': { defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' } } } }, tool: 'claude' },
        { set: 'no default is set', settings: {}, tool: undefined },
        { set: 'the default\'s instance cannot run now', settings: { defaultModelSelection: CODEX_DEFAULT }, providers: [CLAUDE, { ...CODEX, constraints: ['Provider is not authenticated.'] }], tool: undefined },
        { set: '`instance` names another instance than the default\'s', settings: { defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' } }, providers: [CLAUDE, { ...CLAUDE, providerInstanceId: 'claude-work' }], options: { instance: 'claude-work' }, tool: undefined },
        { set: 'the default runs a provider this runtime does not run', settings: { defaultModelSelection: { instanceId: 'opencode', model: 'big-pickle' } }, tool: undefined },
        {
          set: 'the default instance runs another command than Claude\'s own, a wrapper teamai has no tool for',
          settings: { defaultModelSelection: { instanceId: 'acme-claude-t3', model: 'claude-opus-5-5' }, providerInstances: { 'acme-claude-t3': { config: { binaryPath: '/opt/acme/bin/acme-claude' } } } },
          providers: [CLAUDE, CODEX, { ...CLAUDE, providerInstanceId: 'acme-claude-t3' }], tool: 'claude',
        },
      ])('reports the tool of the member\'s effective T3 default when $set', async ({ settings, providers, options, tool }) => {
        signIn(t3);
        t3.settings(settings);

        if (providers) t3.config({ providers });
        // teamai starts the runtime in the run's checkout, and names it in init.
        const runtime = start({}, dir);

        runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local', ...options }, checkout });
        const reply = await runtime.next((line) => line['type'] === 'init');

        expect(RuntimeMessageSchema.safeParse(reply).success).toBe(true);
        expect(reply).toMatchObject({ ok: true });
        expect(z.object({ default_tool: z.string().optional() }).parse(reply['can']).default_tool).toBe(tool);
      });
    });

    describe('a team or personal tool instance', () => {
      const ACME = { ...CLAUDE, providerInstanceId: 'acme-claude-t3', displayName: 'Claude (acme)' };
      const INSTANCE = { name: 'acme-claude', tool: 'claude', command: 'acme-claude' };

      /** The init reply for `instances` given in init, `options` added to the definition's, and each provider instance's Binary path. */
      const initWith = async ({ binaryPaths, options = {}, providers = [CLAUDE, CODEX, ACME], instances = [INSTANCE] }: { binaryPaths: Record<string, string>; options?: Line; providers?: FakeT3Config['providers']; instances?: Line[] }): Promise<Line> => {
        signIn(t3);
        t3.config({ providers });
        t3.settings({ providerInstances: Object.fromEntries(Object.entries(binaryPaths).map(([id, binaryPath]) => [id, { config: { binaryPath } }])) });
        const runtime = start();
        runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local', ...options }, instances, homeEnv: { ...SHIPPED_HOME_ENV, ...Object.fromEntries(instances.map((instance) => [instance['name'], ['CLAUDE_CONFIG_DIR']])) } });
        const reply = await runtime.next((line) => line['type'] === 'init');
        expect(RuntimeMessageSchema.safeParse(reply).success, JSON.stringify(reply)).toBe(true);

        return reply;
      };

      // T3 Code starts a Binary path as given: an absolute path, or a name it finds on its PATH.
      it.each([
        { case: 'an absolute path to', binaryPath: '/opt/acme/bin/acme-claude' },
        { case: 'the name of', binaryPath: 'acme-claude' },
      ])('offers it on the T3 provider instance whose Binary path is $case its command', async ({ binaryPath }) => {
        const reply = await initWith({ binaryPaths: { 'acme-claude-t3': binaryPath } });

        expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'codex', 'acme-claude'], confined: [{ tools: ['claude', 'codex', 'acme-claude'] }] } });
        expect(reply).not.toHaveProperty('unavailable');
      });

      it.each([
        { case: 'a Binary path relative to a folder', binaryPath: 'bin/acme-claude' },
        { case: 'a Binary path to another file', binaryPath: '/opt/acme/bin/acme-claude-old' },
      ])('does not offer it on an instance with $case, and names the instance to add when teamai cannot add it', async ({ binaryPath }) => {
        const reply = await initWith({ binaryPaths: { 'acme-claude-t3': binaryPath } });

        expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'codex'] } });
        expect(reply['unavailable']).toEqual({
          'acme-claude': 'No T3 Code provider instance runs acme-claude, and teamai cannot add one: acme-claude is not on PATH here. Install acme-claude, or add one in T3 Code under Settings → Providers, with driver Claude and Binary path the absolute path of acme-claude (command -v acme-claude), or map one with instances: { acme-claude: <its id> } in the definition\'s t3 options.',
        });
      });

      // teamai passes every instance the member may run, so one that is ambiguous must not stop the steps on the others.
      it('does not offer it, naming both and the option that picks one, when two instances run its command, and still offers the rest', async () => {
        const reply = await initWith({
          binaryPaths: { 'acme-claude-t3': '/opt/acme/bin/acme-claude', 'acme-claude-2': '/usr/local/bin/acme-claude' },
          providers: [CLAUDE, ACME, { ...ACME, providerInstanceId: 'acme-claude-2' }],
        });

        expect(reply).toMatchObject({ ok: true, can: { tools: ['claude'] } });
        expect(reply['unavailable']).toEqual({
          'acme-claude': 'T3 Code provider instances "acme-claude-t3" and "acme-claude-2" both run acme-claude. Pick one with instances: { acme-claude: <its id> } in the definition\'s t3 options.',
        });
      });

      it('keeps its other tools, naming the key under unavailable, when `instances` maps a name that is neither a tool T3 runs nor an instance teamai passed', async () => {
        const reply = await initWith({ binaryPaths: { 'acme-claude-t3': '/opt/acme/bin/acme-claude' }, options: { instances: { 'acme-cluade': 'acme-claude-t3' } } });

        expect(reply).toMatchObject({
          ok: true, can: { tools: ['claude', 'codex', 'acme-claude'] },
          unavailable: { 'acme-cluade': 'instances names acme-cluade, which is neither claude, codex nor a tool instance teamai has here. Remove instances.acme-cluade, or name the instance as its tool definition does.' },
        });
      });

      it('cuts a reason longer than protocol 1 takes, marking where it was cut', async () => {
        const reply = await initWith({
          binaryPaths: { 'acme-claude-t3': '/opt/acme/bin/acme-claude' },
          options: { instances: { 'acme-claude': 'acme-claude-t3' } },
          providers: [CLAUDE, CODEX, { ...ACME, constraints: ['Provider is not ready. '.repeat(30)] }],
        });
        const reason = z.record(z.string(), z.string()).parse(reply['unavailable'])['acme-claude'] ?? '';

        expect(reason).toHaveLength(UNAVAILABLE_REASON_MAX);
        expect(reason.endsWith('…')).toBe(true);
      });

      // A step that never names the misspelt key would not show its reason, so the member hears of it at the start.
      it('says once, before it answers init, that `instances` names a key that is neither a tool T3 runs nor an instance teamai passed', async () => {
        signIn(t3);
        t3.config({ providers: [CLAUDE, CODEX, ACME] });
        t3.settings({ providerInstances: { 'acme-claude-t3': { config: { binaryPath: '/opt/acme/bin/acme-claude' } } } });
        const runtime = start();
        runtime.send({ type: 'init', protocol: 1, mode: 'unattended', options: { environment: 'local', instances: { 'acme-cluade': 'acme-claude-t3', clade: 'claudeAgent' } }, instances: [INSTANCE], homeEnv: { ...SHIPPED_HOME_ENV, 'acme-claude': ['CLAUDE_CONFIG_DIR'] } });
        await runtime.next((line) => line['type'] === 'init');

        expect(runtime.lines.slice(0, -1)).toEqual([
          { event: 'notice', message: 'instances names acme-cluade, which is neither claude, codex nor a tool instance teamai has here. Remove instances.acme-cluade, or name the instance as its tool definition does.' },
          { event: 'notice', message: 'instances names clade, which is neither claude, codex nor a tool instance teamai has here. Remove instances.clade, or name the instance as its tool definition does.' },
        ]);
      });

      // T3 runs the instance in its own home, so the instance signs in there and keeps its sessions there, not in teamai's.
      it.each([
        { case: 'has no home of its own, so runs in Claude\'s', homePath: undefined, notice: 'T3 Code provider instance "acme-claude-t3" runs acme-claude in ~/.claude, while teamai gives acme-claude the home ~/.acme-claude: on T3 it signs in and keeps its sessions there. To use the same home, set the instance\'s Home path in T3 Code under Settings → Providers to ~/.acme-claude.' },
        { case: 'has another home', homePath: '~/.acme-old', notice: 'T3 Code provider instance "acme-claude-t3" runs acme-claude in ~/.acme-old, while teamai gives acme-claude the home ~/.acme-claude: on T3 it signs in and keeps its sessions there. To use the same home, set the instance\'s Home path in T3 Code under Settings → Providers to ~/.acme-claude.' },
        { case: 'has the same home', homePath: '~/.acme-claude', notice: undefined },
      ])('says once when the instance that runs it $case than teamai gives it', async ({ homePath, notice }) => {
        signIn(t3);
        t3.config({ providers: [CLAUDE, CODEX, ACME] });
        t3.settings({ providerInstances: { 'acme-claude-t3': { config: { binaryPath: '/opt/acme/bin/acme-claude', ...(homePath && { homePath }) } } } });
        const runtime = start();
        runtime.send({ type: 'init', protocol: 1, mode: 'unattended', options: { environment: 'local' }, instances: [{ ...INSTANCE, home: { dir: '.acme-claude' } }], homeEnv: { ...SHIPPED_HOME_ENV, 'acme-claude': ['CLAUDE_CONFIG_DIR'] } });

        expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, can: { tools: ['claude', 'codex', 'acme-claude'] } });
        expect(noticesOf(runtime)).toEqual(notice === undefined ? [] : [{ event: 'notice', message: notice }]);
      });

      it('runs it on the instance `instances` maps it to', async () => {
        const reply = await initWith({ binaryPaths: { 'acme-claude-t3': '/opt/acme/bin/acme-claude', 'acme-claude-2': '/usr/local/bin/acme-claude' }, providers: [CLAUDE, ACME, { ...ACME, providerInstanceId: 'acme-claude-2' }], options: { instances: { 'acme-claude': 'acme-claude-2' } } });

        expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'acme-claude'] } });
      });

      it.each([
        { case: 'that T3 lacks', mapped: 'acme-sandbox', message: 'T3 Code has no provider instance "acme-sandbox", which instances maps acme-claude to. Add or enable it in T3 Code under Settings → Providers, or remove instances.acme-claude' },
        { case: 'of another driver', mapped: 'codex', message: 'T3 Code provider instance "codex" runs codex, and acme-claude extends claude. Map acme-claude to a Claude instance in instances.acme-claude' },
        { case: 'whose Binary path runs another file', mapped: 'acme-claude-t3', message: 'T3 Code provider instance "acme-claude-t3" has the Binary path /opt/acme/bin/claude, which is not acme-claude, the command acme-claude runs. Set its Binary path in T3 Code under Settings → Providers to the absolute path of acme-claude (command -v acme-claude), or change instances.acme-claude' },
      ])('offers the other tools and names the setting under unavailable, for a mapping to an instance $case', async ({ mapped, message }) => {
        const reply = await initWith({ binaryPaths: { 'acme-claude-t3': '/opt/acme/bin/claude' }, options: { instances: { 'acme-claude': mapped } } });

        expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'codex'] }, unavailable: { 'acme-claude': message } });
      });

      it('keeps offering claude on its default instance when the team adjusts claude with no command of its own', async () => {
        const reply = await initWith({ binaryPaths: {}, instances: [{ name: 'claude', tool: 'claude', home: { dir: '/home/member/.claude-team' } }] });

        expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'codex'] } });
        expect(reply).not.toHaveProperty('unavailable');
      });

      it('offers no claude, naming the setting under unavailable, when `instances` maps claude to an instance T3 lacks, and keeps codex', async () => {
        const reply = await initWith({ binaryPaths: {}, options: { instances: { claude: 'claude-work' } } });

        expect(reply).toMatchObject({
          ok: true, can: { tools: ['codex'] },
          unavailable: { claude: 'T3 Code has no provider instance "claude-work", which instances maps claude to. Add or enable it in T3 Code under Settings → Providers, or remove instances.claude' },
        });
      });
    });

    describe('with `runtime_mode: full-access`', () => {
      const FULL_ACCESS_SCOPES = ['--scope', 'orchestration:read', '--scope', 'orchestration:operate', '--scope', 'settings:write', '--scope', 'source-control:write'];

      it('signs in with Full access through a pairing code carrying the scopes T3 needs for it, and reports every tool it offers as running in full access', async () => {
        const runtime = start();

        runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'unattended', options: { environment: 'local', runtime_mode: 'full-access' } });
        const reply = await runtime.next((line) => line['type'] === 'init');

        expect(RuntimeMessageSchema.safeParse(reply).success).toBe(true);
        expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'codex'], unattended: false }, permissions: { claude: 'full-access', codex: 'full-access' } });
        expect(t3.commandRuns()).toEqual([['auth', 'pairing', 'create', '--json', '--base-dir', t3.t3Home, ...FULL_ACCESS_SCOPES, '--ttl', '2m', '--label', 'teamai workflow']]);
        expect(t3.calls().find((call) => call.tool === 'oauth_decision')?.args).toEqual({ access: 'full-access' });
      });

      it('signs in again with Full access when the kept sign-in was approved with Auto, and a later Auto run keeps the new one', async () => {
        signIn(t3, undefined, undefined, 'orchestration:read orchestration:operate');
        const runtime = start();

        runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'unattended', options: { environment: 'local', runtime_mode: 'full-access' } });

        expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, permissions: { claude: 'full-access' } });
        expect(t3.calls().find((call) => call.tool === 'oauth_decision')?.args).toEqual({ access: 'full-access' });
        await runtime.close();

        const later = start();
        later.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'unattended', options: { environment: 'local' } });

        expect(await later.next((line) => line['type'] === 'init')).not.toHaveProperty('permissions');
        expect(t3.calls().filter((call) => call.tool === 'oauth_token')).toHaveLength(1);
      });

      it('asks the person to approve Full access when it signs in through T3\'s page', async () => {
        t3.config({ pageAccess: 'full-access' });
        const browser = fakeBrowser(dir);
        const runtime = start({ PATH: `${browser.bin}${path.delimiter}${PATH_WITHOUT_T3}` });

        runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local', runtime_mode: 'full-access' } });

        const reply = await runtime.next((line) => line['type'] === 'init');
        expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true, permissions: { claude: 'full-access' } });
        expect(noticesOf(runtime)).toEqual([{ event: 'notice', message: expect.stringMatching(/^Approve teamai in T3 Code with Full access, since runtime_mode is full-access \(silent sign-in failed: found no t3 command .*\)\. If no browser opened, visit: http:\/\/127\.0\.0\.1:\d+\/oauth\/mcp\/authorize\?\S+$/) }]);
      });

      it('fails sign_in_too_narrow, naming the fix, when the person approves only Auto access in T3\'s page, which it opens once', async () => {
        const browser = fakeBrowser(dir);
        const runtime = start({ PATH: `${browser.bin}${path.delimiter}${PATH_WITHOUT_T3}` });

        runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local', runtime_mode: 'full-access' } });

        expect(await runtime.next((line) => line['type'] === 'init')).toEqual({
          type: 'init', ok: false,
          error: {
            code: 'sign_in_too_narrow',
            message: 'teamai\'s T3 Code sign-in was approved without Full access, which runtime_mode full-access needs. Start the workflow again and pick Full access in the page T3 Code opens, or remove runtime_mode: full-access.',
          },
        });
        // A second page could not complete: the run already answered, and nothing listens for its approval.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(browser.visits()).toEqual(['/oauth/mcp/authorize']);
        expect(noticesOf(runtime)).toHaveLength(1);
      });
    });

    // teamai quotes a keyed option failure inside a sentence of its own and ends it, so these messages bring no full stop.
    it.each(['yolo'])('refuses `runtime_mode: %s`, a mode it never starts a thread in', async (runtimeMode) => {
      signIn(t3);
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local', runtime_mode: runtimeMode } });

      expect(await runtime.next((line) => line['type'] === 'init')).toEqual({
        type: 'init', ok: false,
        error: {
          code: 'bad_option', key: 'runtime_mode',
          message: `runtime_mode "${runtimeMode}" is not one runtime t3 takes. A step thread runs in the member's T3 default mode, or auto, never full access unless runtime_mode says so; runtime_mode sets it to auto, auto-accept-edits, approval-required or full-access. Remove it, or set one of those four`,
        },
      });
      expect(t3.calls()).toEqual([]);
    });

    it('names an option it does not take', async () => {
      signIn(t3);
      const runtime = start();

      runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local', instnace: 'x' } });

      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'instnace' } });
    });
  });
});
