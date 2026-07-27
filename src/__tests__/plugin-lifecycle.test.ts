import { describe, it, expect } from 'vitest';
import {
  reconcilePlugins,
  teardownAllPlugins,
  parseGetConfig,
  substituteVars,
  unresolvedPlaceholders,
  commandFingerprint,
  type PluginDescriptor,
  type PluginState,
  type ReconcileDeps,
} from '../plugin-lifecycle.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeDescriptor(overrides: Partial<PluginDescriptor> = {}): PluginDescriptor {
  return {
    slug: 'cls-codebuddy',
    version: '1.0.0',
    installCmd: 'npm install -g cls-plugin@1.0.0',
    uninstallCmd: 'npm uninstall -g cls-plugin',
    runCmd: 'cls-codebuddy setup',
    ...overrides,
  };
}

/** Build a fake ReconcileDeps backed by an in-memory map plus a call-order log. */
function makeDeps(
  initial: Record<string, PluginState> = {},
  opts: { nowMs?: number } = {},
): ReconcileDeps & { calls: string[]; map: Record<string, PluginState>; nowMs: number } {
  let nowMs = opts.nowMs ?? 0;
  const map: Record<string, PluginState> = { ...initial };
  const calls: string[] = [];

  return {
    calls,
    map,
    get nowMs() {
      return nowMs;
    },
    set nowMs(v: number) {
      nowMs = v;
    },

    async readPlugins() {
      return { ...map };
    },
    async mutatePlugins(fn) {
      fn(map);
    },
    async execCommand(cmd) {
      calls.push(`exec:${cmd}`);
    },
    now() {
      return nowMs;
    },
    log: { debug() {}, warn() {} },
  };
}

// ---------------------------------------------------------------------------
// 1. Fresh install
// ---------------------------------------------------------------------------

describe('reconcilePlugins – fresh install', () => {
  it('calls install then run in order and marks ready', async () => {
    const deps = makeDeps();
    const d = makeDescriptor();

    await reconcilePlugins([d], deps);

    expect(deps.calls).toEqual([
      `exec:${d.installCmd}`,
      `exec:${d.runCmd}`,
    ]);
    expect(deps.map[d.slug]).toMatchObject({ ready: true, version: '1.0.0' });
    expect(deps.map[d.slug].lastError).toBeUndefined();
    expect(deps.map[d.slug].lastAttemptAt).toBeUndefined();
    expect(deps.map[d.slug].cmdFingerprint).toBe(commandFingerprint(d));
  });
});

// ---------------------------------------------------------------------------
// 2. Install failure + cooldown + retry
// ---------------------------------------------------------------------------

describe('reconcilePlugins – install failure and cooldown', () => {
  it('records lastError on failure, skips on cooldown, retries after cooldown expires', async () => {
    const deps = makeDeps();
    deps.execCommand = async (cmd: string) => {
      deps.calls.push(`exec:${cmd}`);
      throw new Error('npm install failed');
    };
    const d = makeDescriptor();

    // First attempt: fails
    await reconcilePlugins([d], deps);
    expect(deps.map[d.slug]).toMatchObject({ ready: false, lastError: 'npm install failed' });
    expect(deps.map[d.slug].lastAttemptAt).toBe(new Date(0).toISOString());
    const firstExecCount = deps.calls.filter((c) => c.startsWith('exec:')).length;
    expect(firstExecCount).toBe(1);

    // Second attempt immediately: should be in cooldown → exec NOT called again
    await reconcilePlugins([d], deps);
    const execCountAfterCooldown = deps.calls.filter((c) => c.startsWith('exec:')).length;
    expect(execCountAfterCooldown).toBe(1); // still 1, not retried

    // Advance time past cooldown (11 minutes)
    deps.nowMs = 11 * 60 * 1000;

    // Make execCommand succeed now
    deps.execCommand = async (cmd: string) => {
      deps.calls.push(`exec:${cmd}`);
    };
    await reconcilePlugins([d], deps);
    const execCountAfterRetry = deps.calls.filter((c) => c.startsWith('exec:')).length;
    // install + run = 2 more execs
    expect(execCountAfterRetry).toBe(3);
    expect(deps.map[d.slug]).toMatchObject({ ready: true });
  });
});

// ---------------------------------------------------------------------------
// 3. Version change
// ---------------------------------------------------------------------------

describe('reconcilePlugins – version update', () => {
  it('runs updateCmd then runCmd in order and updates manifest version', async () => {
    const existing: PluginState = {
      slug: 'cls-codebuddy',
      version: '1.0.0',
      ready: true,
      uninstallCmd: 'npm uninstall -g cls-plugin',
    };
    const deps = makeDeps({ 'cls-codebuddy': existing });
    const d = makeDescriptor({ version: '2.0.0', updateCmd: 'npm install -g cls-plugin@2.0.0' });

    await reconcilePlugins([d], deps);

    const execIdx = (cmd: string) => deps.calls.indexOf(`exec:${cmd}`);
    expect(execIdx(d.updateCmd!)).toBeGreaterThanOrEqual(0);
    expect(execIdx(d.runCmd)).toBeGreaterThanOrEqual(0);
    expect(execIdx(d.updateCmd!)).toBeLessThan(execIdx(d.runCmd));
    expect(deps.map[d.slug].version).toBe('2.0.0');
    expect(deps.map[d.slug].ready).toBe(true);
  });

  it('falls back to installCmd when updateCmd is absent', async () => {
    const existing: PluginState = {
      slug: 'cls-codebuddy',
      version: '1.0.0',
      ready: true,
      uninstallCmd: 'npm uninstall -g cls-plugin',
    };
    const deps = makeDeps({ 'cls-codebuddy': existing });
    const d = makeDescriptor({ version: '2.0.0', updateCmd: undefined });

    await reconcilePlugins([d], deps);

    expect(deps.calls).toContain(`exec:${d.installCmd}`);
    expect(deps.map[d.slug].version).toBe('2.0.0');
  });
});

// ---------------------------------------------------------------------------
// 4. Steady state – same version → no-op
// ---------------------------------------------------------------------------

describe('reconcilePlugins – steady state no-op', () => {
  it('issues zero commands when version is unchanged and plugin is ready', async () => {
    const d = makeDescriptor();
    const existing: PluginState = {
      slug: 'cls-codebuddy',
      version: '1.0.0',
      ready: true,
      uninstallCmd: 'npm uninstall -g cls-plugin',
      cmdFingerprint: commandFingerprint(d),
    };
    const deps = makeDeps({ 'cls-codebuddy': existing });

    await reconcilePlugins([d], deps);

    expect(deps.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4a. No-version steady state → no-op when already ready
// ---------------------------------------------------------------------------

describe('reconcilePlugins – no version, already ready → no-op', () => {
  it('issues zero commands when desired has no version and plugin is already ready', async () => {
    const d = makeDescriptor({ slug: 'cls', version: undefined, uninstallCmd: 'cls-codebuddy uninstall-all' });
    const existing: PluginState = {
      slug: 'cls',
      version: undefined,
      ready: true,
      uninstallCmd: 'cls-codebuddy uninstall-all',
      cmdFingerprint: commandFingerprint(d),
    };
    const deps = makeDeps({ cls: existing });

    await reconcilePlugins([d], deps);

    expect(deps.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4b. Command / launch-arg change → re-run even when version is unchanged
// ---------------------------------------------------------------------------

describe('reconcilePlugins – command fingerprint change', () => {
  it('re-runs update + run when runCmd launch args change but version is the same', async () => {
    const oldDesc = makeDescriptor({
      version: '1.0.0',
      runCmd: 'cls-codebuddy setup --topic-id OLD',
      updateCmd: 'npm install -g cls-plugin@1.0.0',
    });
    const existing: PluginState = {
      slug: oldDesc.slug,
      version: '1.0.0',
      ready: true,
      uninstallCmd: oldDesc.uninstallCmd,
      cmdFingerprint: commandFingerprint(oldDesc),
    };
    const deps = makeDeps({ [oldDesc.slug]: existing });
    // Same version, but the topic-id launch arg changed.
    const newDesc = makeDescriptor({
      version: '1.0.0',
      runCmd: 'cls-codebuddy setup --topic-id NEW',
      updateCmd: 'npm install -g cls-plugin@1.0.0',
    });

    await reconcilePlugins([newDesc], deps);

    expect(deps.calls).toEqual([
      `exec:${newDesc.updateCmd}`,
      `exec:${newDesc.runCmd}`,
    ]);
    expect(deps.map[newDesc.slug].cmdFingerprint).toBe(commandFingerprint(newDesc));
    expect(deps.map[newDesc.slug].ready).toBe(true);
  });

  it('re-runs when installCmd changes even if runCmd and version are unchanged', async () => {
    const oldDesc = makeDescriptor({ version: '1.0.0', installCmd: 'npm i -g cls@1.0.0 --registry OLD' });
    const existing: PluginState = {
      slug: oldDesc.slug,
      version: '1.0.0',
      ready: true,
      uninstallCmd: oldDesc.uninstallCmd,
      cmdFingerprint: commandFingerprint(oldDesc),
    };
    const deps = makeDeps({ [oldDesc.slug]: existing });
    const newDesc = makeDescriptor({ version: '1.0.0', installCmd: 'npm i -g cls@1.0.0 --registry NEW' });

    await reconcilePlugins([newDesc], deps);

    // No updateCmd → falls back to installCmd, then runCmd.
    expect(deps.calls).toEqual([
      `exec:${newDesc.installCmd}`,
      `exec:${newDesc.runCmd}`,
    ]);
  });

  it('backfills fingerprint without re-running when legacy state lacks one', async () => {
    const d = makeDescriptor({ version: '1.0.0' });
    const existing: PluginState = {
      slug: d.slug,
      version: '1.0.0',
      ready: true,
      uninstallCmd: d.uninstallCmd,
      // cmdFingerprint intentionally absent (installed before fingerprinting existed)
    };
    const deps = makeDeps({ [d.slug]: existing });

    await reconcilePlugins([d], deps);

    // No commands executed…
    expect(deps.calls).toHaveLength(0);
    // …but the fingerprint is now recorded so future drift is detected.
    expect(deps.map[d.slug].cmdFingerprint).toBe(commandFingerprint(d));
  });
});

// ---------------------------------------------------------------------------
// 5. Plugin removed from desired → execCommand(uninstallCmd) + delete, no deregister
// ---------------------------------------------------------------------------

describe('reconcilePlugins – plugin disappears from desired', () => {
  it('calls execCommand(uninstallCmd) then deletes entry; no deregister call', async () => {
    const existing: PluginState = {
      slug: 'cls-codebuddy',
      version: '1.0.0',
      ready: true,
      uninstallCmd: 'npm uninstall -g cls-plugin',
    };
    const deps = makeDeps({ 'cls-codebuddy': existing });

    // desired is empty
    await reconcilePlugins([], deps);

    expect(deps.calls).toEqual([`exec:${existing.uninstallCmd}`]);
    expect(deps.map['cls-codebuddy']).toBeUndefined();
    // No deregister call
    expect(deps.calls.some((c) => c.startsWith('deregister:'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. teardownAllPlugins
// ---------------------------------------------------------------------------

describe('teardownAllPlugins', () => {
  it('uninstalls all plugins and empties the map; no deregister', async () => {
    const map: Record<string, PluginState> = {
      'plugin-a': {
        slug: 'plugin-a',
        version: '1.0.0',
        ready: true,
        uninstallCmd: 'npm uninstall -g plugin-a',
      },
      'plugin-b': {
        slug: 'plugin-b',
        version: '2.0.0',
        ready: true,
        uninstallCmd: 'npm uninstall -g plugin-b',
      },
    };
    const deps = makeDeps(map);

    await teardownAllPlugins(deps);

    expect(deps.map).toEqual({});
    expect(deps.calls).toContain('exec:npm uninstall -g plugin-a');
    expect(deps.calls).toContain('exec:npm uninstall -g plugin-b');
    expect(deps.calls.some((c) => c.startsWith('deregister:'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. parseGetConfig
// ---------------------------------------------------------------------------

describe('parseGetConfig', () => {
  it('parses real response structure: cls section with commands + vars', () => {
    const resp = {
      cls: {
        endpoint: 'ap-guangzhou.cls.tencentcs.com',
        topic_id: 'f7e11f3b-xxxx',
        secret_id: 'AKIDxxxx',
        secret_key: 'sk-xxxx',
        user_id: 37,
        user_name: 'admin123',
        install_cmd: 'npm install -g tencentcloud-cls-sdk-codebuddy-test --registry https://mirrors.tencentyun.com/npm/',
        update_cmd: 'npm install -g tencentcloud-cls-sdk-codebuddy-test --registry https://mirrors.tencentyun.com/npm/',
        uninstall_cmd: 'cls-codebuddy uninstall-all',
        run_cmd: 'cls-codebuddy setup --endpoint ${endpoint} --topic-id ${topic_id} --secret-id ${secret_id} --secret-key ${secret_key} --service-name ${local_agent_id} --user-name ${user_name} --user-id ${user_id}',
      },
    };

    const result = parseGetConfig(resp);

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]).toMatchObject({
      slug: 'cls',
      installCmd: 'npm install -g tencentcloud-cls-sdk-codebuddy-test --registry https://mirrors.tencentyun.com/npm/',
      updateCmd: 'npm install -g tencentcloud-cls-sdk-codebuddy-test --registry https://mirrors.tencentyun.com/npm/',
      uninstallCmd: 'cls-codebuddy uninstall-all',
      runCmd: 'cls-codebuddy setup --endpoint ${endpoint} --topic-id ${topic_id} --secret-id ${secret_id} --secret-key ${secret_key} --service-name ${local_agent_id} --user-name ${user_name} --user-id ${user_id}',
    });
    expect(result.plugins[0].version).toBeUndefined();
    expect(result.vars).toEqual({
      endpoint: 'ap-guangzhou.cls.tencentcs.com',
      topic_id: 'f7e11f3b-xxxx',
      secret_id: 'AKIDxxxx',
      secret_key: 'sk-xxxx',
      user_id: '37',
      user_name: 'admin123',
    });
  });

  it('returns 0 plugins when install_cmd is missing', () => {
    const resp = {
      cls: {
        uninstall_cmd: 'cls-codebuddy uninstall-all',
        run_cmd: 'cls-codebuddy setup',
        // install_cmd intentionally absent
      },
    };
    expect(parseGetConfig(resp).plugins).toHaveLength(0);
  });

  it('returns 0 plugins when run_cmd is missing', () => {
    const resp = {
      cls: {
        install_cmd: 'npm install -g cls-sdk',
        uninstall_cmd: 'cls-codebuddy uninstall-all',
        // run_cmd intentionally absent
      },
    };
    expect(parseGetConfig(resp).plugins).toHaveLength(0);
  });

  it('returns 0 plugins when uninstall_cmd is missing', () => {
    const resp = {
      cls: {
        install_cmd: 'npm install -g cls-sdk',
        run_cmd: 'cls-codebuddy setup',
        // uninstall_cmd intentionally absent
      },
    };
    expect(parseGetConfig(resp).plugins).toHaveLength(0);
  });

  it('handles null and non-object inputs without throwing', () => {
    expect(parseGetConfig(null)).toEqual({ vars: {}, plugins: [] });
    expect(parseGetConfig(undefined)).toEqual({ vars: {}, plugins: [] });
    expect(parseGetConfig('string')).toEqual({ vars: {}, plugins: [] });
  });

  it('converts user_id number to string in vars', () => {
    const resp = {
      cls: {
        user_id: 37,
        user_name: 'admin123',
        install_cmd: 'npm install -g x',
        uninstall_cmd: 'x uninstall',
        run_cmd: 'x setup',
      },
    };
    const { vars } = parseGetConfig(resp);
    expect(vars['user_id']).toBe('37');
    expect(vars['user_name']).toBe('admin123');
  });

  it('skips non-object section values', () => {
    const resp = { cls: 'not-an-object', other: 42 };
    expect(parseGetConfig(resp).plugins).toHaveLength(0);
    expect(parseGetConfig(resp).vars).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 8. substituteVars
// ---------------------------------------------------------------------------

describe('substituteVars', () => {
  it('replaces known placeholders', () => {
    const vars = { endpoint: 'https://cls.example.com', local_agent_id: 'codebuddy-abc123' };
    expect(substituteVars('setup --endpoint ${endpoint} --name ${local_agent_id}', vars)).toBe(
      'setup --endpoint https://cls.example.com --name codebuddy-abc123',
    );
  });

  it('leaves unknown placeholders untouched', () => {
    expect(substituteVars('cmd --secret ${secret_key} --x ${unknown}', { secret_key: 'abc' })).toBe(
      'cmd --secret abc --x ${unknown}',
    );
  });

  it('returns cmd unchanged when no placeholders', () => {
    expect(substituteVars('npm install -g cls', {})).toBe('npm install -g cls');
  });
});

// ---------------------------------------------------------------------------
// 9. unresolvedPlaceholders
// ---------------------------------------------------------------------------

describe('unresolvedPlaceholders', () => {
  it('returns names of remaining placeholders after partial substitution', () => {
    const partial = substituteVars(
      'cls setup --endpoint ${endpoint} --secret ${secret_key} --user ${user_id}',
      { endpoint: 'https://cls.example.com' },
    );
    expect(unresolvedPlaceholders(partial)).toEqual(expect.arrayContaining(['secret_key', 'user_id']));
    expect(unresolvedPlaceholders(partial)).toHaveLength(2);
  });

  it('returns empty array when all placeholders are resolved', () => {
    const vars = { endpoint: 'https://cls.example.com', local_agent_id: 'codebuddy-abc123' };
    const resolved = substituteVars('setup --endpoint ${endpoint} --name ${local_agent_id}', vars);
    expect(unresolvedPlaceholders(resolved)).toHaveLength(0);
  });

  it('deduplicates repeated placeholder names', () => {
    expect(unresolvedPlaceholders('${key} and ${key} again')).toEqual(['key']);
  });
});

// ---------------------------------------------------------------------------
// 10. commandFingerprint
// ---------------------------------------------------------------------------

describe('commandFingerprint', () => {
  it('is stable for identical command sets', () => {
    const a = makeDescriptor();
    const b = makeDescriptor();
    expect(commandFingerprint(a)).toBe(commandFingerprint(b));
  });

  it('changes when a provisioning command field changes', () => {
    const base = makeDescriptor();
    const baseFp = commandFingerprint(base);
    expect(commandFingerprint(makeDescriptor({ installCmd: base.installCmd + ' --x' }))).not.toBe(baseFp);
    expect(commandFingerprint(makeDescriptor({ runCmd: base.runCmd + ' --topic-id NEW' }))).not.toBe(baseFp);
    expect(commandFingerprint(makeDescriptor({ updateCmd: 'npm up -g cls' }))).not.toBe(baseFp);
  });

  it('is unaffected by uninstallCmd (only runs on removal, not provisioning)', () => {
    const base = makeDescriptor();
    const changed = makeDescriptor({ uninstallCmd: base.uninstallCmd + ' --purge' });
    expect(commandFingerprint(changed)).toBe(commandFingerprint(base));
  });

  it('is unaffected by version (version is tracked separately)', () => {
    const a = makeDescriptor({ version: '1.0.0' });
    const b = makeDescriptor({ version: '2.0.0' });
    expect(commandFingerprint(a)).toBe(commandFingerprint(b));
  });

  it('does not collide when content shifts across field boundaries', () => {
    const x = commandFingerprint(makeDescriptor({ installCmd: 'a', runCmd: 'bc' }));
    const y = commandFingerprint(makeDescriptor({ installCmd: 'ab', runCmd: 'c' }));
    expect(x).not.toBe(y);
  });
});
