import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { credentialsFile, fakeBrowser, PATH_WITHOUT_T3, signIn, type Connection, type Line } from './testing/harness.js';
import { dir, ended, isNotice, noticesOf, OPEN, prompt, result, RUN, SHIPPED_HOME_ENV, start, t3, usePromptStep, useT3Runtime, worktree } from './testing/suite.js';

describe('teamai-runtime-t3', () => {
  useT3Runtime();

  describe('a prompt step', () => {
    usePromptStep();

    describe('a tool instance no T3 provider instance runs yet', () => {
      const ACME ={ name: 'acme-claude', tool: 'claude', command: 'acme-claude' };
      const HOME_ENV = { ...SHIPPED_HOME_ENV, 'acme-claude': ['CLAUDE_CONFIG_DIR'] };
      const AUTO = 'orchestration:read orchestration:operate';
      const FULL = 'orchestration:read orchestration:operate settings:write source-control:write';
      const MEMBER_SETTINGS = { defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' }, providerInstances: { cursor: { driver: 'cursor', enabled: true } } };
      let bin: string;

      beforeEach(() => {
        // The team's wrapper and Claude itself, on the member's PATH.
        bin = path.join(dir, 'acme-bin');
        fs.mkdirSync(bin);

        for (const command of ['acme-claude', 'claude']) fs.writeFileSync(path.join(bin, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        t3.settings(MEMBER_SETTINGS);
      });

      const settingsNow = (): unknown => JSON.parse(fs.readFileSync(path.join(t3.t3Home, 'userdata', 'settings.json'), 'utf8'));
      const pathWith = (...dirs: string[]): string => [...dirs, bin, PATH_WITHOUT_T3].join(path.delimiter);
      const pairings = (): string[][] => t3.commandRuns().map((args) => args.map((arg) => (arg === t3.t3Home ? '<t3 home>' : arg)));

      const initOn = async ({ mode = 'attended', env = {}, instances = [ACME], homeEnv = HOME_ENV }: { mode?: 'attended' | 'unattended'; env?: Record<string, string>; instances?: Line[]; homeEnv?: Record<string, string[]> } = {}): Promise<{ runtime: Connection; reply: Line }> => {
        const runtime = start({ PATH: pathWith(t3.bin), ...env });
        runtime.send({ type: 'init', protocol: 1, mode, options: { environment: 'local' }, instances, homeEnv });

        return { runtime, reply: await runtime.next((line) => line['type'] === 'init') };
      };

      /** Opens the place of a step that runs `tool`, and answers how the open ended. */
      const openFor = async (runtime: Connection, tool: string, op = OPEN, attempt = 'a1b2c3d4'): Promise<Line> => {
        runtime.send({ type: 'open', op, run: RUN, attempt, tool, credentials: {}, view: { worktree, readonly: [], result: path.dirname(result), runDir: path.join(dir, 'run'), toolHome: {} } });
        await runtime.next((line) => line['op'] === op && line['event'] === 'accepted');

        return runtime.next((line) => line['op'] === op && line['event'] !== 'accepted' && !isNotice(line), 30_000);
      };

      const ADDED = (binaryPath: string) => ({ driver: 'claudeAgent', displayName: 'acme-claude', enabled: true, config: { binaryPath } });

      // A run's CLAUDE_CONFIG_DIR, such as the one T3 sets in a thread, is not a home the tool has for every run.
      it('adds a command-only instance with no Home path when CLAUDE_CONFIG_DIR moves Claude\'s home', async () => {
        signIn(t3, undefined, undefined, AUTO);
        const { runtime } = await initOn({ env: { CLAUDE_CONFIG_DIR: path.join(dir, 'claude-config') } });

        expect(await openFor(runtime, 'acme-claude')).toMatchObject({ event: 'ready' });
        expect(settingsNow()).toEqual({ ...MEMBER_SETTINGS, providerInstances: { ...MEMBER_SETTINGS.providerInstances, 'acme-claude': ADDED(path.join(bin, 'acme-claude')) } });
      });

      it('offers it at init and writes nothing there, then adds it on the first open that runs it, as the member, keeping every other setting, and runs the step on it', async () => {
        signIn(t3, undefined, undefined, AUTO);
        const { runtime, reply } = await initOn();

        expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'codex', 'acme-claude'] } });
        expect(reply).not.toHaveProperty('unavailable');
        expect(settingsNow()).toEqual(MEMBER_SETTINGS);
        expect(t3.commandRuns()).toEqual([]);

        expect(await openFor(runtime, 'acme-claude')).toMatchObject({ event: 'ready' });

        expect(settingsNow()).toEqual({ ...MEMBER_SETTINGS, providerInstances: { ...MEMBER_SETTINGS.providerInstances, 'acme-claude': ADDED(path.join(bin, 'acme-claude')) } });
        expect(pairings()).toEqual([]);
        expect(noticesOf(runtime)).toContainEqual({
          event: 'notice', op: OPEN,
          message: `Added the T3 Code provider instance "acme-claude" (driver Claude, Binary path ${path.join(bin, 'acme-claude')}), so acme-claude runs on T3 Code. It stays for later runs; remove it in T3 Code under Settings → Providers.`,
        });

        runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-00000021', { tool: 'acme-claude' }));

        expect(await ended(runtime, 'op-00000021')).toMatchObject({ event: 'finished', session: { tool: 'acme-claude' } });
        expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args['modelSelection']).toEqual({ instanceId: 'acme-claude', model: 'claude-opus-5-5' });
      });

      it('runs a later run on the instance it added, writing nothing and asking for nothing', async () => {
        t3.settings({ ...MEMBER_SETTINGS, providerInstances: { ...MEMBER_SETTINGS.providerInstances, 'acme-claude': ADDED(path.join(bin, 'acme-claude')) } });
        const written = fs.readFileSync(path.join(t3.t3Home, 'userdata', 'settings.json'));
        const { runtime, reply } = await initOn({ mode: 'unattended' });

        expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'codex', 'acme-claude'] } });
        expect(await openFor(runtime, 'acme-claude')).toMatchObject({ event: 'ready' });
        expect(fs.readFileSync(path.join(t3.t3Home, 'userdata', 'settings.json'))).toEqual(written);
        expect(t3.commandRuns()).toEqual([]);
        expect(noticesOf(runtime)).toEqual([]);
      });

      // teamai writes T3's settings file as the member, as Paseo's runtime adds a provider: no T3 grant is involved.
      it.each([
        { mode: 'unattended' as const, with: 'the t3 command' },
        { mode: 'unattended' as const, with: 'no t3 command' },
        { mode: 'attended' as const, with: 'no t3 command' },
      ])('adds it in an $mode run with $with on the Auto sign-in it has, opening no page and minting no sign-in', async ({ mode, with: command }) => {
        signIn(t3, undefined, undefined, AUTO);
        const browser = fakeBrowser(dir);
        const { runtime, reply } = await initOn({ mode, env: { PATH: command === 'no t3 command' ? pathWith(browser.bin) : pathWith(browser.bin, t3.bin) } });

        expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'codex', 'acme-claude'] } });
        expect(reply).not.toHaveProperty('unavailable');
        expect(await openFor(runtime, 'acme-claude')).toMatchObject({ event: 'ready' });
        expect(settingsNow()).toMatchObject({ providerInstances: { 'acme-claude': ADDED(path.join(bin, 'acme-claude')) } });
        expect(pairings()).toEqual([]);
        expect(browser.visits()).toEqual([]);
        expect(fs.readFileSync(credentialsFile(t3.home), 'utf8')).not.toContain('settings:write');
      });

      it('adds it once when two runs open steps on it at once', async () => {
        signIn(t3, undefined, undefined, FULL);
        const [first, second] = await Promise.all([initOn({ mode: 'unattended' }), initOn({ mode: 'unattended' })]);

        // A judge's place: no worktree, so both runs open at once.
        const judgeOpen = (runtime: Connection, op: string): Promise<Line> => {
          runtime.send({ type: 'open', op, run: RUN, attempt: op, tool: 'acme-claude', credentials: {} });

          return runtime.next((line) => line['op'] === op && line['event'] !== 'accepted' && !isNotice(line), 30_000);
        };

        expect(await Promise.all([judgeOpen(first.runtime, 'op-00000031'), judgeOpen(second.runtime, 'op-00000032')])).toMatchObject([{ event: 'ready' }, { event: 'ready' }]);
        expect(settingsNow()).toEqual({ ...MEMBER_SETTINGS, providerInstances: { ...MEMBER_SETTINGS.providerInstances, 'acme-claude': ADDED(path.join(bin, 'acme-claude')) } });
        expect([...noticesOf(first.runtime), ...noticesOf(second.runtime)].filter((line) => String(line['message']).startsWith('Added'))).toHaveLength(1);
      });

      it('adds it again, telling the person again, on a later open after the member removed it in T3 Code', async () => {
        signIn(t3, undefined, undefined, AUTO);
        const { runtime } = await initOn({ mode: 'unattended' });
        const judgeOpen = (op: string): Promise<Line> => {
          runtime.send({ type: 'open', op, run: RUN, attempt: op, tool: 'acme-claude', credentials: {} });

          return runtime.next((line) => line['op'] === op && line['event'] !== 'accepted' && !isNotice(line), 30_000);
        };

        expect(await judgeOpen('op-00000041')).toMatchObject({ event: 'ready' });
        t3.settings(MEMBER_SETTINGS);

        expect(await judgeOpen('op-00000042')).toMatchObject({ event: 'ready' });
        expect(settingsNow()).toEqual({ ...MEMBER_SETTINGS, providerInstances: { ...MEMBER_SETTINGS.providerInstances, 'acme-claude': ADDED(path.join(bin, 'acme-claude')) } });
        expect(noticesOf(runtime).filter((line) => String(line['message']).startsWith('Added')).map((line) => line['op'])).toEqual(['op-00000041', 'op-00000042']);
      });

      // teamai accepts a prompt before the runtime asks T3 anything slow, so a cancel then finds the op it ends.
      it('ends a prompt cancelled while T3 lists the instances it added, launching nothing', async () => {
        signIn(t3, undefined, undefined, AUTO);
        const { runtime } = await initOn();
        expect(await openFor(runtime, 'acme-claude')).toMatchObject({ event: 'ready' });
        t3.config({ providersMs: 3_000 });

        runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-00000051', { tool: 'acme-claude' }));
        await runtime.next((line) => line['op'] === 'op-00000051' && line['event'] === 'accepted', 1_000);
        runtime.send({ type: 'cancel', op: 'op-00000051' });

        expect(await runtime.next((line) => line['op'] === 'op-00000051' && line['event'] !== 'accepted' && !isNotice(line), 2_000)).toEqual({ op: 'op-00000051', event: 'cancelled' });
        await new Promise((resolve) => setTimeout(resolve, 3_500));
        expect(runtime.lines.filter((line) => line['op'] === 'op-00000051' && !isNotice(line)).map((line) => line['event'])).toEqual(['accepted', 'cancelled']);
        expect(t3.calls().filter((call) => call.tool === 't3_thread_launch')).toEqual([]);
      });

      it('does not offer it, naming what to do, when T3 already has a provider instance of that name that runs another command', async () => {
        signIn(t3, undefined, undefined, FULL);
        const taken = { ...MEMBER_SETTINGS, providerInstances: { ...MEMBER_SETTINGS.providerInstances, 'acme-claude': { driver: 'claudeAgent', config: { binaryPath: '/opt/old/claude-old' } } } };
        t3.settings(taken);
        const { reply } = await initOn({ mode: 'unattended' });

        expect(reply).toMatchObject({
          ok: true, can: { tools: ['claude', 'codex'] },
          unavailable: {
            'acme-claude': 'No T3 Code provider instance runs acme-claude, and teamai cannot add one: T3 Code already has a provider instance "acme-claude" that runs another command. Point its Binary path at acme-claude, or map another with instances: { acme-claude: <its id> } in the definition\'s t3 options.',
          },
        });
        expect(settingsNow()).toEqual(taken);
      });

      it('offers the instance another run just added and T3 has not listed yet, and runs on it, writing nothing and asking for nothing', async () => {
        signIn(t3, undefined, undefined, AUTO);
        const added = { ...MEMBER_SETTINGS, providerInstances: { ...MEMBER_SETTINGS.providerInstances, 'acme-claude': ADDED(path.join(bin, 'acme-claude')) } };
        t3.settings(added);
        t3.config({ unlistedOnce: ['acme-claude'] });
        const { runtime, reply } = await initOn({ mode: 'unattended' });

        expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'codex', 'acme-claude'] } });
        expect(reply).not.toHaveProperty('unavailable');
        expect(await openFor(runtime, 'acme-claude')).toMatchObject({ event: 'ready' });
        expect(settingsNow()).toEqual(added);
        expect(pairings()).toEqual([]);
      });

      it('writes the absolute path of the command when the member\'s PATH names its folder relatively', async () => {
        signIn(t3, undefined, undefined, FULL);
        const runtime = start({ PATH: ['acme-bin', t3.bin, PATH_WITHOUT_T3].join(path.delimiter) }, dir);
        runtime.send({ type: 'init', protocol: 1, mode: 'unattended', options: { environment: 'local' }, instances: [ACME], homeEnv: HOME_ENV });
        await runtime.next((line) => line['type'] === 'init');

        expect(await openFor(runtime, 'acme-claude')).toMatchObject({ event: 'ready' });
        expect(settingsNow()).toMatchObject({ providerInstances: { 'acme-claude': ADDED(path.join(bin, 'acme-claude')) } });
      });

      it('fails the open naming T3\'s settings file, and changes nothing, when that file is not valid JSON', async () => {
        signIn(t3, undefined, undefined, FULL);
        const { runtime } = await initOn({ mode: 'unattended' });
        const file = path.join(t3.t3Home, 'userdata', 'settings.json');
        fs.writeFileSync(file, '{ "providerInstances": ');

        expect(await openFor(runtime, 'acme-claude')).toMatchObject({
          event: 'failed',
          failure: {
            code: 'open_failed',
            message: `teamai could not add a T3 Code provider instance for acme-claude: T3 Code's settings file ${fs.realpathSync(file)} is not valid JSON. Add one in T3 Code under Settings → Providers, with driver Claude and Binary path ${path.join(bin, 'acme-claude')}.`,
          },
        });
        expect(fs.readFileSync(file, 'utf8')).toBe('{ "providerInstances": ');
      });

      // T3 Code sets only the base tool's home variable from a provider instance's Home path, so the command would read another home.
      it.each([
        { world: 'no provider instance runs it yet', settings: MEMBER_SETTINGS },
        { world: 'a provider instance already runs it', settings: { ...MEMBER_SETTINGS, providerInstances: { ...MEMBER_SETTINGS.providerInstances, 'acme-claude': { driver: 'claudeAgent', enabled: true, config: { binaryPath: '/opt/acme/bin/acme-claude' } } } } },
      ])('does not offer an instance that reads its home from a variable of its own, naming the variable and what to do, when $world', async ({ settings }) => {
        signIn(t3, undefined, undefined, FULL);
        t3.settings(settings);
        const { reply } = await initOn({ mode: 'unattended', instances: [{ ...ACME, home: { dir: '.acme-claude' } }], homeEnv: { ...HOME_ENV, 'acme-claude': ['CLAUDE_CONFIG_DIR', 'ACME_CLAUDE_CONFIG_DIR'] } });

        expect(reply).toMatchObject({
          ok: true, can: { tools: ['claude', 'codex'] },
          unavailable: {
            'acme-claude': 'acme-claude reads its home from ACME_CLAUDE_CONFIG_DIR, which T3 Code cannot set: it starts a provider instance with a Binary path and a Home path only, so acme-claude would read another home than the one teamai delivered to. Remove home.env from the acme-claude tool definition, so teamai sets CLAUDE_CONFIG_DIR, or run its steps on another runtime.',
          },
        });
        expect(settingsNow()).toEqual(settings);
        expect(pairings()).toEqual([]);
      });

      it('does not offer it, naming what to do, when its name is not one T3 takes for a provider instance', async () => {
        signIn(t3, undefined, undefined, FULL);
        const { reply } = await initOn({ mode: 'unattended', instances: [{ ...ACME, name: 'acme.claude' }] });

        expect(reply).toMatchObject({
          ok: true, can: { tools: ['claude', 'codex'] },
          unavailable: {
            'acme.claude': `No T3 Code provider instance runs acme.claude, and teamai cannot add one: T3 Code takes no provider instance named "acme.claude" (a letter, then letters, digits, _ or -). Add one in T3 Code under Settings → Providers, with driver Claude and Binary path ${path.join(bin, 'acme-claude')}, and map it with instances: { acme.claude: <its id> } in the definition's t3 options.`,
          },
        });
        expect(settingsNow()).toEqual(MEMBER_SETTINGS);
      });

      // A second account of the same tool: no command of its own, a home of its own.
      it('fails the open and stays up when T3 Code fails to list its instances after the add, and a later open runs on the instance', async () => {
        signIn(t3, undefined, undefined, FULL);
        t3.config({ providersFailOnceAdded: 'acme-claude' });
        const { runtime } = await initOn({ mode: 'unattended' });

        expect(await openFor(runtime, 'acme-claude')).toMatchObject({
          event: 'failed',
          failure: {
            code: 'open_failed',
            message: 'T3 Code cannot run the provider instance "acme-claude" for acme-claude yet: T3 Code did not say which provider instances it runs (T3 Code is restarting its providers). Fix that, then retry the step; the instance is in T3 Code under Settings → Providers.',
          },
        });
        expect(await openFor(runtime, 'acme-claude', 'op-0000000b', 'b2c3d4e5')).toMatchObject({ event: 'ready' });
      });

      it('fails the open saying what T3 Code needs, when the instance it added cannot run, such as a tool not signed in in its home', async () => {
        signIn(t3, undefined, undefined, FULL);
        t3.config({ addedInstanceConstraints: ['Claude Code is not authenticated. Run `claude auth login` and try again.'] });
        const { runtime } = await initOn({ mode: 'unattended', instances: [{ name: 'claude-work', tool: 'claude', home: { dir: '.claude-work' } }], homeEnv: { ...HOME_ENV, 'claude-work': ['CLAUDE_CONFIG_DIR'] } });

        expect(await openFor(runtime, 'claude-work')).toMatchObject({
          event: 'failed',
          failure: {
            code: 'open_failed',
            message: 'T3 Code cannot run the provider instance "claude-work" for claude-work yet: Claude Code is not authenticated. Run `claude auth login` and try again. It runs in ~/.claude-work. Fix that, then retry the step; the instance is in T3 Code under Settings → Providers.',
          },
        });
      }, 40_000);

      // Setting Claude's own home as the Home path moves where Claude keeps its config file.
      it.each([
        { case: 'a home of its own, as its Home path', dir: '.acme-claude', homePath: () => ({ homePath: path.join(t3.home, '.acme-claude') }) },
        { case: 'Claude\'s own home, with no Home path', dir: '.claude', homePath: () => ({}) },
      ])('adds a team tool that names $case', async ({ dir: homeDir, homePath }) => {
        signIn(t3, undefined, undefined, FULL);
        const { runtime } = await initOn({ mode: 'unattended', instances: [{ ...ACME, home: { dir: homeDir } }] });

        expect(await openFor(runtime, 'acme-claude')).toMatchObject({ event: 'ready' });
        expect(settingsNow()).toEqual({
          ...MEMBER_SETTINGS,
          providerInstances: { ...MEMBER_SETTINGS.providerInstances, 'acme-claude': { ...ADDED(path.join(bin, 'acme-claude')), config: { binaryPath: path.join(bin, 'acme-claude'), ...homePath() } } },
        });
      });

      it('adds an instance with a home of its own and no command on its tool\'s own binary in that home, rather than running it on the member\'s Claude', async () => {
        signIn(t3, undefined, undefined, FULL);
        const { runtime, reply } = await initOn({ mode: 'unattended', instances: [{ name: 'claude-work', tool: 'claude', home: { dir: '.claude-work' } }], homeEnv: { ...HOME_ENV, 'claude-work': ['CLAUDE_CONFIG_DIR'] } });

        expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'codex', 'claude-work'] } });
        expect(await openFor(runtime, 'claude-work')).toMatchObject({ event: 'ready' });
        expect(settingsNow()).toMatchObject({
          providerInstances: { 'claude-work': { driver: 'claudeAgent', displayName: 'claude-work', enabled: true, config: { binaryPath: path.join(bin, 'claude'), homePath: path.join(t3.home, '.claude-work') } } },
        });

        runtime.send(prompt(`t3-${RUN}-a1b2c3d4`, 'op-00000022', { tool: 'claude-work' }));

        expect(await ended(runtime, 'op-00000022')).toMatchObject({ event: 'finished', session: { tool: 'claude-work', home: path.join(t3.home, '.claude-work') } });
        expect(t3.calls().find((call) => call.tool === 't3_thread_launch')?.args['modelSelection']).toEqual({ instanceId: 'claude-work', model: 'claude-opus-5-5' });
      });
    });
  });
});
