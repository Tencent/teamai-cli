/**
 * Field registry for the local teamai config — the single source of truth for
 * which `LocalConfig` fields are editable (via `teamai config set` or the
 * Config WebUI settings form), how values are validated, and what side
 * effects run after a save.
 *
 * Consumed by:
 *   - src/config-service.ts  (readConfigBundle / applyConfigPatch)
 *   - src/config-cmd.ts      (teamai config list/get/set)
 *   - src/config-ui-html.ts  (settings form rendering)
 *
 * Contract: every optionally-editable LocalConfigSchema key is classified
 * exactly once here (enforced by config-fields.test.ts). Structural keys that
 * no UI/CLI path may ever write are listed in INTERNAL_CONFIG_KEYS.
 */
import type { Scope, LocalConfig } from './types.js';

export type FieldType = 'string' | 'enum' | 'boolean' | 'boolean-tri' | 'string[]';

/** Dynamic option sources resolved per-request by the config service. */
export type DynamicOptions = 'roles' | 'tags' | 'skills';

export type FieldGroup = 'Repo' | 'Roles' | 'Tags' | 'Sync' | 'Recall' | 'Agents';

export interface ConfigFieldSpec {
  /** Dot path in LocalConfig, e.g. 'repo.branch'. */
  key: string;
  group: FieldGroup;
  /** English label (CLI output; the WebUI carries its own zh-CN label map). */
  label: string;
  /** English description (CLI help text). */
  description: string;
  type: FieldType;
  /** Static enum values (type 'enum'). */
  enumValues?: readonly string[];
  /** Options resolved per-request by the service (type 'enum'/'string[]'). */
  dynamicOptions?: DynamicOptions;
  /** Scopes in which the field is editable. */
  scopes: Scope[];
  /** v1 read-only: rendered with a CLI hint, never writable. */
  readOnly?: boolean;
  /** Hint shown when readOnly (which CLI command manages this field). */
  readOnlyHint?: string;
  /** Compute the next config from current + new value. Default: deep-set at key. */
  apply?: (cfg: LocalConfig, value: unknown) => LocalConfig;
  /** Post-save side effect (runs AFTER zod validation + persist). */
  afterSave?: (cfg: LocalConfig) => Promise<void>;
}

/** Error carrying the offending field key, surfaced per-field by the service. */
export class ConfigFieldError extends Error {
  readonly key: string;
  constructor(key: string, message: string) {
    super(message);
    this.name = 'ConfigFieldError';
    this.key = key;
  }
}

/**
 * Structural LocalConfig keys that no registry consumer may write. They are
 * managed exclusively by init/pull/uninstall and validated by the coverage
 * test so a schema change cannot silently grow an unclassified field.
 *
 *  - repo.url, repo.businessRepoRoot: mode-specific transport fields (init)
 *  - resourceProfileVersion:          managed by init/pull role sync
 *  - projectRoot:                     structural, equals the scope root
 */
export const INTERNAL_CONFIG_KEYS: readonly string[] = [
  'repo.url',
  'repo.businessRepoRoot',
  'resourceProfileVersion',
  'projectRoot',
];

export const CONFIG_FIELDS: readonly ConfigFieldSpec[] = [
  {
    key: 'updatePolicy',
    group: 'Sync',
    label: 'Update policy',
    description: 'teamai update behavior: auto | prompt | skip',
    type: 'enum',
    enumValues: ['auto', 'prompt', 'skip'],
    scopes: ['user', 'project'],
  },
  {
    key: 'repo.branch',
    group: 'Repo',
    label: 'Tracked branch',
    description: 'Team-repo branch to track instead of the remote default (empty = default branch)',
    type: 'string',
    scopes: ['user', 'project'],
    apply: (cfg, value) => {
      const branch = typeof value === 'string' ? value.trim() : '';
      const repo = { ...cfg.repo };
      if (branch) {
        repo.branch = branch;
      } else {
        delete repo.branch;
      }
      return { ...cfg, repo };
    },
    afterSave: async (cfg) => {
      const { pinCloneToBranch } = await import('./utils/branch-manager.js');
      const { resolveDefaultBranch } = await import('./config-service.js');
      // Non-empty pin: trust the value. Empty (unset): return to the remote
      // default branch so pull anchors follow it again.
      const target = cfg.repo.branch?.trim()
        ?? (await resolveDefaultBranch(cfg.repo.localPath, cfg.repo.kind));
      if (target) {
        await pinCloneToBranch(cfg.repo.localPath, target);
      }
    },
  },
  {
    key: 'inheritUserScope',
    group: 'Repo',
    label: 'Inherit user scope',
    description: 'In project scope, also sync safe user-scope resources and search its knowledge',
    type: 'boolean',
    scopes: ['project'],
  },
  {
    key: 'primaryRole',
    group: 'Roles',
    label: 'Primary role',
    description: 'Primary role ID from the team roles manifest',
    type: 'enum',
    dynamicOptions: 'roles',
    scopes: ['user', 'project'],
  },
  {
    key: 'additionalRoles',
    group: 'Roles',
    label: 'Additional roles',
    description: 'Extra role IDs merged into your resource namespaces',
    type: 'string[]',
    dynamicOptions: 'roles',
    scopes: ['user', 'project'],
  },
  {
    key: 'subscribedTags',
    group: 'Tags',
    label: 'Subscribed tags',
    description: 'Tags to subscribe to (empty = pull all resources)',
    type: 'string[]',
    dynamicOptions: 'tags',
    scopes: ['user', 'project'],
  },
  {
    key: 'excludedSkills',
    group: 'Sync',
    label: 'Excluded skills',
    description: 'Skills to exclude from local sync (per-user, does not affect team repo)',
    type: 'string[]',
    dynamicOptions: 'skills',
    scopes: ['user', 'project'],
    afterSave: async (cfg) => {
      // Mirror src/exclude.ts: a changed exclude list must bypass pull's
      // unchanged-revision fast path, or excluded skills stay installed
      // until the next repo-side change.
      const { loadStateForScope, saveStateForScope } = await import('./config.js');
      try {
        const state = await loadStateForScope(cfg.scope, cfg.projectRoot);
        state.lastPullRev = null;
        await saveStateForScope(state, cfg.scope, cfg.projectRoot);
      } catch {
        // Missing/corrupt state is non-critical: the next pull performs a full sync.
      }
    },
  },
  {
    key: 'recallEnabled',
    group: 'Recall',
    label: 'Knowledge recall',
    description: 'Override the team recall default: unset | true | false',
    type: 'boolean-tri',
    scopes: ['user', 'project'],
    afterSave: async (cfg) => {
      // Reuse the recall-toggle artifact routines (not a plain write):
      // toggling adds/removes the recall rule/agent files in every AI-tool dir.
      const { loadTeamConfig } = await import('./config.js');
      const { deployRecallArtifacts, removeRecallArtifacts } = await import('./recall-toggle.js');
      const teamConfig = await loadTeamConfig(cfg.repo.localPath);
      if (!teamConfig) return;
      if (cfg.recallEnabled === false) {
        await removeRecallArtifacts(teamConfig, cfg);
      } else if (cfg.recallEnabled === true) {
        await deployRecallArtifacts(teamConfig, cfg);
      }
    },
  },
  {
    key: 'coAuthorEnabled',
    group: 'Sync',
    label: 'Co-author trailer',
    description: 'Override the team co-author default: unset | true | false',
    type: 'boolean-tri',
    scopes: ['user', 'project'],
  },
  // ─── Read-only (v1): display + CLI hint ────────────────────
  {
    key: 'username',
    group: 'Repo',
    label: 'Username',
    description: 'Your team member username',
    type: 'string',
    scopes: [],
    readOnly: true,
    readOnlyHint: 'teamai init',
  },
  {
    key: 'repo.localPath',
    group: 'Repo',
    label: 'Clone path',
    description: 'Local path of the team repo clone',
    type: 'string',
    scopes: [],
    readOnly: true,
    readOnlyHint: 'teamai init',
  },
  {
    key: 'repo.remote',
    group: 'Repo',
    label: 'Remote',
    description: 'Remote URL of the team repo',
    type: 'string',
    scopes: [],
    readOnly: true,
    readOnlyHint: 'teamai init',
  },
  {
    key: 'repo.kind',
    group: 'Repo',
    label: 'Repo kind',
    description: 'Team repo backend: git | http | self',
    type: 'string',
    scopes: [],
    readOnly: true,
    readOnlyHint: 'teamai init',
  },
  {
    key: 'scope',
    group: 'Repo',
    label: 'Scope',
    description: 'Install scope of this config: user | project',
    type: 'string',
    scopes: [],
    readOnly: true,
    readOnlyHint: 'teamai init --scope',
  },
  {
    key: 'enabledAgents',
    group: 'Agents',
    label: 'Enabled agents',
    description: 'AI tools this install syncs into (additive via init --agent)',
    type: 'string[]',
    scopes: [],
    readOnly: true,
    readOnlyHint: 'teamai init --agent <name>',
  },
  {
    key: 'disabledAgents',
    group: 'Agents',
    label: 'Disabled agents',
    description: 'AI tools excluded from all teamai sync (set by uninstall --agent)',
    type: 'string[]',
    scopes: [],
    readOnly: true,
    readOnlyHint: 'teamai uninstall --agent <name>',
  },
];

/** Look up a field spec by dot-path key. */
export function findFieldSpec(key: string): ConfigFieldSpec | undefined {
  return CONFIG_FIELDS.find((f) => f.key === key);
}
