/** Plugin lifecycle reconciliation engine. All I/O is injected via `ReconcileDeps` for pure-logic testing. */

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** Desired plugin state delivered by the backend get-config response. */
export interface PluginDescriptor {
  slug: string;
  version?: string;
  /** Install package + inject hooks. Does not start the daemon. */
  installCmd: string;
  /** Falls back to `installCmd` when absent. */
  updateCmd?: string;
  uninstallCmd: string;
  /** Setup command; plugin daemonizes itself and registers autostart. */
  runCmd: string;
}

/** Persisted plugin state in the local manifest. */
export interface PluginState {
  slug: string;
  version?: string;
  /** true = installed and setup completed; false = partial/failed. */
  ready: boolean;
  installedAt?: string;
  /** Required: needed by uninstall when the plugin is removed from desired list. */
  uninstallCmd: string;
  /** ISO timestamp of last failed attempt; used for failure cooldown. */
  lastAttemptAt?: string;
  lastError?: string;
}

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

/** All external effects are injected so the reconciler can be unit-tested in isolation. */
export interface ReconcileDeps {
  /** Read the current plugin manifest (slug -> PluginState). */
  readPlugins(): Promise<Record<string, PluginState>>;
  /**
   * Atomically mutate the plugin manifest. The caller holds a cross-process
   * lock around load → fn(map) → save.
   */
  mutatePlugins(fn: (map: Record<string, PluginState>) => void): Promise<void>;
  /**
   * Execute a shell command string. Rejects on non-zero exit or timeout.
   * Callers must ensure the command string contains no secret material.
   */
  execCommand(cmd: string, timeoutMs: number): Promise<void>;
  /** Return current epoch milliseconds. Injected so tests can control time. */
  now(): number;
  log: { debug(msg: string): void; warn(msg: string): void };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;
const UNINSTALL_TIMEOUT_MS = 5 * 60 * 1000;
/** Setup daemonizes quickly; allow 1 minute. */
const RUN_TIMEOUT_MS = 60 * 1000;
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function makeReadyState(d: PluginDescriptor, deps: ReconcileDeps): PluginState {
  return {
    slug: d.slug,
    version: d.version,
    ready: true,
    installedAt: new Date(deps.now()).toISOString(),
    uninstallCmd: d.uninstallCmd,
    lastAttemptAt: undefined,
    lastError: undefined,
  };
}

// ---------------------------------------------------------------------------
// Core exports
// ---------------------------------------------------------------------------

/**
 * Reconcile desired plugin state against local manifest.
 *
 * Phase A: for each desired plugin, install/update as needed; plugin self-daemonizes via runCmd.
 * Phase B: for each locally-known plugin absent from desired, uninstall it.
 * Each plugin is handled independently; one failure does not block others.
 */
export async function reconcilePlugins(
  desired: PluginDescriptor[],
  deps: ReconcileDeps,
): Promise<void> {
  const local = await deps.readPlugins();
  const desiredSlugs = new Set(desired.map((d) => d.slug));

  // Phase A: install / update / steady-state
  for (const d of desired) {
    const e = local[d.slug];
    try {
      if (!e || !e.ready) {
        // Not installed or previous attempt failed → try install (subject to cooldown)
        if (e?.lastAttemptAt && deps.now() - Date.parse(e.lastAttemptAt) < FAILURE_COOLDOWN_MS) {
          deps.log.debug(`plugin ${d.slug}: in failure cooldown, skip`);
          continue;
        }
        deps.log.debug(`plugin ${d.slug}: installing${d.version ? ' version ' + d.version : ''}`);
        await deps.execCommand(d.installCmd, INSTALL_TIMEOUT_MS);
        await deps.execCommand(d.runCmd, RUN_TIMEOUT_MS);
        await deps.mutatePlugins((m) => {
          m[d.slug] = makeReadyState(d, deps);
        });
        deps.log.debug(`plugin ${d.slug}: installed and setup complete`);
      } else if (d.version !== undefined && e.version !== d.version) {
        // Version changed → update
        deps.log.debug(`plugin ${d.slug}: updating ${e.version ?? '(unknown)'} -> ${d.version}`);
        await deps.execCommand(d.updateCmd ?? d.installCmd, UPDATE_TIMEOUT_MS);
        await deps.execCommand(d.runCmd, RUN_TIMEOUT_MS);
        await deps.mutatePlugins((m) => {
          m[d.slug] = makeReadyState(d, deps);
        });
        deps.log.debug(`plugin ${d.slug}: updated to version ${d.version}`);
      }
      // else: steady state — plugin self-manages, teamai is no-op
    } catch (err) {
      const msg = (err as Error).message;
      deps.log.warn(`plugin ${d.slug} reconcile failed: ${msg}`);
      await deps.mutatePlugins((m) => {
        const prev = m[d.slug];
        const base: PluginState = prev ?? {
          slug: d.slug,
          version: d.version,
          ready: false,
          uninstallCmd: d.uninstallCmd,
        };
        // Preserve ready=true if the plugin was already healthy (transient error)
        if (!prev || !prev.ready) {
          base.ready = false;
        }
        base.lastAttemptAt = new Date(deps.now()).toISOString();
        base.lastError = msg;
        m[d.slug] = base;
      });
    }
  }

  // Phase B: remove plugins that are no longer in desired list
  for (const slug of Object.keys(local)) {
    if (desiredSlugs.has(slug)) continue;
    const e = local[slug];
    try {
      deps.log.debug(`plugin ${slug}: uninstalling (removed from desired list)`);
      await deps.execCommand(e.uninstallCmd, UNINSTALL_TIMEOUT_MS);
      await deps.mutatePlugins((m) => {
        delete m[slug];
      });
      deps.log.debug(`plugin ${slug}: uninstalled`);
    } catch (err) {
      deps.log.warn(`plugin ${slug} uninstall failed: ${(err as Error).message}`);
    }
  }
}

/**
 * Tear down all locally-tracked plugins.
 *
 * Called when uninstalling teamai itself. Each plugin is handled independently;
 * a failure only warns and continues.
 */
export async function teardownAllPlugins(deps: ReconcileDeps): Promise<void> {
  const plugins = await deps.readPlugins();
  for (const [slug, state] of Object.entries(plugins)) {
    try {
      deps.log.debug(`plugin ${slug}: tearing down`);
      await deps.execCommand(state.uninstallCmd, UNINSTALL_TIMEOUT_MS);
      await deps.mutatePlugins((m) => {
        delete m[slug];
      });
      deps.log.debug(`plugin ${slug}: torn down`);
    } catch (err) {
      deps.log.warn(`plugin ${slug} teardown failed: ${(err as Error).message}`);
    }
  }
}

/**
 * Parse a raw get-config response into structured plugin descriptors and substitution vars.
 *
 * New contract: iterate over each top-level key; if the value is an object that contains
 * non-empty `install_cmd`, `run_cmd`, and `uninstall_cmd` strings, it is a plugin whose
 * slug equals that key. Substitution vars (endpoint, topic_id, etc.) are extracted from
 * the same section.
 */
export function parseGetConfig(resp: unknown): { vars: Record<string, string>; plugins: PluginDescriptor[] } {
  const vars: Record<string, string> = {};
  const plugins: PluginDescriptor[] = [];
  if (!resp || typeof resp !== 'object') return { vars, plugins };
  for (const [key, section] of Object.entries(resp as Record<string, unknown>)) {
    if (!section || typeof section !== 'object') continue;
    const s = section as Record<string, unknown>;
    const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
    if (!isStr(s['install_cmd']) || !isStr(s['run_cmd']) || !isStr(s['uninstall_cmd'])) continue;
    // substitution vars: scalar fields referenced by ${...} in run_cmd
    for (const f of ['endpoint', 'topic_id', 'secret_id', 'secret_key', 'user_name'] as const) {
      if (isStr(s[f])) vars[f] = s[f] as string;
    }
    if (typeof s['user_id'] === 'number') vars['user_id'] = String(s['user_id']);
    else if (isStr(s['user_id'])) vars['user_id'] = s['user_id'] as string;
    plugins.push({
      slug: key,
      version: isStr(s['version']) ? (s['version'] as string) : undefined,
      installCmd: s['install_cmd'] as string,
      updateCmd: isStr(s['update_cmd']) ? (s['update_cmd'] as string) : undefined,
      uninstallCmd: s['uninstall_cmd'] as string,
      runCmd: s['run_cmd'] as string,
    });
  }
  return { vars, plugins };
}

/** Replace ${key} occurrences in cmd with vars[key]. Unknown keys are left untouched. */
export function substituteVars(cmd: string, vars: Record<string, string>): string {
  return cmd.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, key: string) =>
    key in vars ? vars[key] : match
  );
}

/** Return the list of unresolved ${...} placeholder names remaining in cmd. */
export function unresolvedPlaceholders(cmd: string): string[] {
  const found = new Set<string>();
  for (const match of cmd.matchAll(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)) {
    found.add(match[1]);
  }
  return [...found];
}
