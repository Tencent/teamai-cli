# Design: Config WebUI — Team Configuration Repository Console

- **Branch**: `feat/config-webui` (cut from `release/teamai-gl-v3` @ `275b8f2`)
- **Status**: Approved plan, ready for implementation
- **Estimated effort**: 6–7 person-days across 4 independently deliverable milestones
- **New runtime dependencies**: NONE (zero-dependency, same posture as the existing dashboard)

---

## 1. Goal

A local Web UI (`teamai config ui`, binds `127.0.0.1:3722`) that manages the **team
configuration repository** (e.g. `http://172.16.1.23:28080/huangweizhao/teamai-demo`):

1. **Repo** — overview of the configured team repo (remote, provider, kind, tracked
   branch, clone path, sync state, branch health).
2. **Branches** — list remote branches of the config repo (`git ls-remote --heads`);
   select one and **re-initialize** the project/user install non-interactively
   (`init --branch <sel> --force`), then **sync** (`pull --force`) — all as a
   background **job** with live logs.
3. **Roles** — list roles registered in the config repo's `roles.yaml` manifest;
   view and **manage the binding** (`primaryRole` / `additionalRoles`) of the local
   install; binding changes take effect on next pull (offer a sync button).
4. **Resources** — full inventory of the current branch of the config repo:
   `skills / rules / env / agents / docs / hooks / mcp / culture.md / roles` plus the
   **recall knowledge base** (index status, entry list, and a search playground).
   Any file-backed resource can be previewed (markdown rendered or code highlighted).
5. **Settings** — form editing of local config fields (scope-aware), driven by a
   field registry; diff preview before save; inline zod errors.
6. **Sync** — sync state (`state.json`) + a "Sync now" button.

Plus the CLI half sharing the same validation layer:
`teamai config list | get <field> | set <field> <value> | ui`.

### Non-goals (v1)

- No editing of team-owned repo files (`teamai.yaml`, `roles.yaml`, `tags.yaml`,
  hooks sources) — those stay with the existing CLI/PR flows; the UI is **read-only**
  toward the config repo and shows the CLI command to propose changes.
- No remote/LAN access, no auth model: server binds `127.0.0.1` only.
- No handling of API tokens: the token lives in a 0600 file managed by `src/api-key.ts`;
  the service layer never loads it, so it can never leak through the API.
- No bundler/framework: single-file template-literal HTML + vanilla JS (same as
  `src/dashboard-html.ts`).

---

## 2. Ground truth (verified against this tree)

| Fact | Reference |
|---|---|
| Config layers: `teamai.yaml` (team, admin-owned), `~/.teamai/config.yaml` (user), `<project>/.teamai/config.yaml` (project), `state.json` | `src/types.ts` (`TeamaiConfigSchema`, `LocalConfigSchema`, `StateSchema`, `getConfigPath`, `getStatePath`) |
| Scope-aware load/save already exist | `src/config.ts`: `loadLocalConfigForScope`, `saveLocalConfigForScope`, `loadStateForScope`, `saveStateForScope`, `detectProjectConfig`, `autoDetectInit`, `requireInitForScope` |
| Branch pinning primitive: fetch → checkout local from `origin/<b>` → set-upstream → repoint `origin/HEAD`; all sync anchors follow `getDefaultBranch()` | `src/utils/branch-manager.ts`: `pinCloneToBranch`, `ensureBranchState`, `configuredBranch`, `BranchVanishedError`, `cleanupOrphanSkills` |
| Roles manifest schema + helpers | `src/roles.ts`: `loadRolesManifest` (:78), `findRole` (:108), `listRoleIds` (:112), `describeRoles` (:116), `resolveRoleResourceNamespaces` (:130); schema `RoleSchema { id, description, resources: { knowledge[], skills[] } }` |
| Resource enumeration per type already exists | `src/resources/index.ts`: `getAllHandlers()` → `skills/rules/docs/env/agents/hooks/mcp`, each with `scanTeamForPull(teamConfig, localConfig)`; `listDirs` at `src/utils/fs.ts:144` |
| Recall search is local + read-only | `src/utils/search-index.ts`: `loadIndex`, `buildIndex`, `search`, `isLegacyIndex`; usage pattern at `src/recall.ts:285-459` |
| Path-safety util (symlink-resolved containment check) | `src/utils/path-safety.ts`: `assertSafePath(target, allowedRoots)` |
| Lock-file precedent (TTL, reentrant) | `src/utils/import-lock.ts` |
| Web server precedent (zero-dep `node:http`, single-file HTML, SSE, EADDRINUSE handling, graceful shutdown) | `src/dashboard.ts` (port `DASHBOARD_DEFAULT_PORT = 3721`), `src/dashboard-html.ts` (lightweight markdown renderer, `escapeHtml`, `escapeAttr`, CSS theme variables) |
| `init` full non-interactive channel | `src/init.ts`: `init(options)` (:866); `--force` skips every confirmation (:287, :934, :1012, :1187); non-TTY escape (:542: `options.silent || options.force || !process.stdin.isTTY`); `--role` skips role prompt (:1233); `--branch` pins + writes config (:1109, :1224); `--agent` list via `normalizeAgentList` |
| `init` does NOT pull — re-init must be followed by an explicit sync | grep: no `pullRepo` call in `src/init.ts` |
| Pull flags | `teamai pull [--silent] [--force]` (no `--all`; that's push) — `src/index.ts:60`, entry `pull(options)` at `src/pull.ts:1282` |
| SKILL.md description extraction | `gray-matter` (already a dependency) |
| Test baseline to keep green | 179 files / 2455 tests (`npx vitest run`) |

---

## 3. Architecture

```
                       ┌────────────────────────────────────────────┐
 teamai config list ──▶│ src/config-cmd.ts (CLI)                    │
 teamai config get/set │                                            │
 teamai config ui ──┐  └───────────────┬────────────────────────────┘
                    ▼                  ▼
       ┌────────────────────────────────────────────┐
       │ src/config-ui.ts (http server, :3722)      │
       │   GET/POST APIs + job runner               │──▶ src/config-ui-jobs.ts
       └───────────────┬────────────────────────────┘      (spawn CLI subprocesses:
                       ▼                                    init --branch → pull --force)
       ┌────────────────────────────────────────────┐
       │ src/config-service.ts (read/patch/validate)│◀── single write channel
       └───────────────┬────────────────────────────┘
                       ▼
       ┌────────────────────────────────────────────┐
       │ src/config-fields.ts (field registry —     │  single source of truth for
       │ key/type/enum/scope/apply hooks)           │  CLI get/set + UI form + validation
       └────────────────────────────────────────────┘

 Read-only toward the config repo clone (<localPath>): resources, roles.yaml,
 culture.md, recall index. Writes only: user/project local config + state.json,
 plus git pin/checkout inside the team repo clone via branch-manager.
```

Frontend: `src/config-ui-html.ts` — one template-literal HTML page, six tabs
(`Repo / Branches / Roles / Resources / Settings / Sync`), reuse of the dashboard
markdown renderer and CSS variables. Jobs are polled (`GET /api/jobs/:id`, 1s interval).

---

## 4. Files

| File | Status | Responsibility |
|---|---|---|
| `src/config-fields.ts` | new | Field registry (types below); the only place that knows which `LocalConfig` fields are editable and how |
| `src/config-service.ts` | new | `readConfigBundle()`, `applyConfigPatch()` — the only writer of local config |
| `src/config-cmd.ts` | new | `teamai config list/get/set/ui` implementations |
| `src/config-ui.ts` | new | HTTP server + all routes + security; thin, delegates to service/jobs |
| `src/config-ui-jobs.ts` | new | Job registry + subprocess runner (injectable spawn for tests) |
| `src/config-ui-html.ts` | new | The six-tab single-file UI |
| `src/index.ts` | edit | Register `config` command family |
| `src/types.ts` | edit | `CONFIG_UI_DEFAULT_PORT = 3722`; `StateSchema` += `teamRepoDefaultBranch: z.string().optional()` |
| `src/__tests__/config-fields.test.ts` etc. | new | See §9 |

---

## 5. Specifications

### 5.1 `src/types.ts` additions

```ts
export const CONFIG_UI_DEFAULT_PORT = 3722;   // 3721 is the dashboard

// StateSchema gains (optional, backward compatible):
teamRepoDefaultBranch: z.string().optional(),
```

### 5.2 Field registry — `src/config-fields.ts`

```ts
import type { Scope, LocalConfig } from './types.js';

export type FieldType = 'string' | 'enum' | 'boolean' | 'boolean-tri' | 'string[]';

export interface ConfigFieldSpec {
  key: string;                    // dot path in LocalConfig, e.g. 'repo.branch'
  group: 'Repo' | 'Roles' | 'Tags' | 'Sync' | 'Recall' | 'Agents';
  label: string;                  // English
  description: string;            // English
  type: FieldType;
  enumValues?: readonly string[];        // static enums
  dynamicOptions?: 'roles' | 'tags' | 'skills'; // resolved per-request by the service
  scopes: Scope[];                // scopes in which the field is editable
  readOnly?: boolean;             // v1 read-only: render + CLI hint
  /** Compute next config from current + new value. Default: deep-set at key. */
  apply?: (cfg: LocalConfig, value: unknown) => LocalConfig;
  /** Post-save side effect (runs AFTER zod validation + persist). */
  afterSave?: (cfg: LocalConfig) => Promise<void>;
}

export const CONFIG_FIELDS: readonly ConfigFieldSpec[] = [/* table below */];
```

Registry contents (complete — the coverage test in §9 enforces that every
optionally-editable `LocalConfigSchema` key is classified):

| key | group | type | scopes | write path |
|---|---|---|---|---|
| `updatePolicy` | Sync | enum `auto,prompt,skip` | user, project | direct YAML |
| `repo.branch` | Repo | string | user, project | `apply` = set; **`afterSave` = `pinCloneToBranch(cfg.repo.localPath, value)`** (import from `branch-manager.ts`); empty string ⇒ unset + checkout default (see §7 note) |
| `inheritUserScope` | Repo | boolean | project only | direct YAML |
| `primaryRole` | Roles | enum, `dynamicOptions:'roles'` | user, project | `apply` validates id ∈ manifest (`listRoleIds`), else throws `ConfigFieldError` |
| `additionalRoles` | Roles | string[], `dynamicOptions:'roles'` | user, project | same validation per id |
| `subscribedTags` | Tags | string[], `dynamicOptions:'tags'` (from `tags.yaml`) | user, project | validate ∈ tags list |
| `excludedSkills` | Sync | string[], `dynamicOptions:'skills'` | user, project | direct YAML (mirrors `src/exclude.ts` — pure write) |
| `recallEnabled` | Recall | boolean-tri (unset=defer to team) | user, project | **`afterSave` = reuse `src/recall-toggle.ts` enable/disable** — NOT a plain write: toggling adds/remes recall rule/agent files in every AI-tool dir |
| `coAuthorEnabled` | Sync | boolean-tri (unset=defer to team) | user, project | direct YAML (precedence documented in schema) |
| `username`, `repo.localPath`, `repo.remote`, `repo.kind`, `scope`, `enabledAgents`, `disabledAgents` | — | readOnly | — | v1: display + hint (`teamai init …` / `teamai uninstall --agent …`) |

`boolean-tri`: `undefined` ⇒ "defer to team default"; UI renders a 3-way select
(Unset / On / Off); CLI `set` accepts `unset|true|false`.

### 5.3 Config service — `src/config-service.ts`

```ts
export interface ResolvedField { spec: ConfigFieldSpec; value: unknown;
  source: 'user' | 'project' | 'team-default' | 'unset'; }

export interface ConfigBundle {
  scope: Scope;
  localConfig: LocalConfig;
  teamConfig: TeamaiConfig;          // read-only view
  state: State;                      // read-only view
  fields: ResolvedField[];           // registry resolved for this scope
  options: { roles: string[]; tags: string[]; skills: string[] }; // dynamicOptions
}

export async function readConfigBundle(scope: Scope, projectRoot?: string):
  Promise<ConfigBundle>;

export interface ApplyResult {
  ok: boolean;
  config?: LocalConfig;
  errors: Array<{ key: string; message: string }>; // per-field, incl. zod issues
}

/** Ordered pipeline per key: find spec → readOnly? reject → spec.apply ?? deep-set
 *  → LocalConfigSchema.parse (rejects unknown keys) → saveLocalConfigForScope
 *  → spec.afterSave?.(saved) sequentially. Any failure aborts before save; an
 *  afterSave failure is reported in errors[] but the config write stands. */
export async function applyConfigPatch(scope: Scope,
  updates: Record<string | number | symbol, unknown>, projectRoot?: string):
  Promise<ApplyResult>;
```

`source` resolution: project scope reads project config; a key absent there but set
in user config reports `source:'user'` with the user value (display only); absent in
both ⇒ `unset` + team default from `TeamaiConfigSchema` defaults where applicable.

### 5.4 CLI — `src/config-cmd.ts` (register in `src/index.ts`)

```
teamai config list  [--scope user|project]     # table: key | value | source | group | description
teamai config get   <field>                    # dot path from registry; unknown ⇒ exit 1
teamai config set   <field> <value>            # value parsed by field type (JSON for arrays)
teamai config ui    [--port <n>] [--scope <s>] # starts the WebUI (default scope: autoDetect)
```

All output English. `set` uses `applyConfigPatch` (same validation as the UI — this
is the CLI parity guarantee). `ui` prints `http://127.0.0.1:<port>` and stays in the
foreground (Ctrl+C to stop), mirroring `dashboard.ts` shutdown behavior.

### 5.5 HTTP server — `src/config-ui.ts`

Skeleton copied from `src/dashboard.ts`: `node:http`, `server.listen(port, '127.0.0.1')`,
EADDRINUSE ⇒ actionable message (`teamai config ui --port <n+1>`), SIGINT/SIGTERM
graceful shutdown.

**Security (mandatory, enforced in one `guard(req)` helper):**
1. Bind `127.0.0.1` only — never `0.0.0.0`.
2. **No `Access-Control-Allow-Origin` header at all** (the dashboard sets `*` but it
   is GET-only; this server has POST writes — cross-origin must fail).
3. POST only when `Origin` header is absent or equals `http://127.0.0.1:<port>` or
   `http://localhost:<port>`; else `403`.
4. `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding
   guard); else `403`.
5. JSON body limit 1 MB; `application/json` only on POST routes.
6. Tokens/API keys never read ⇒ never returned (assert in tests).

**Routes** (all JSON unless noted; errors: `{ error: string; details?: unknown }`):

| Route | Method | Request | Response |
|---|---|---|---|
| `/` | GET | — | HTML (`config-ui-html.ts`) |
| `/api/repo` | GET | — | `{ remote, provider, kind, localPath, username, scope, trackedBranch: string\|null, defaultBranch: string\|null, state: { lastPull, lastPush, pendingPushes }, health: { checkoutOk, trackingOk, originHeadOk, ahead, behind } }` — health from `ensureBranchState`-style checks implemented read-only (no repair in GET) |
| `/api/repo/branches` | GET | — | `{ kind, currentTracked, defaultBranch, branches: [{ name, sha }] }` — `git ls-remote --heads origin` via `simple-git` in `localPath`; `409` when `kind !== 'git'` |
| `/api/repo/reinit` | POST | `{ branch: string\|null, scope?: Scope, force?: boolean }` | `202 { jobId }`; `400` not initialized / invalid branch; `409 { dirtyFiles }` when clone worktree dirty and `force` unset. Sequence in §5.7 |
| `/api/sync` | POST | `{ scope? }` | `202 { jobId }` — job = `pull --force` |
| `/api/jobs/:id` | GET | — | `{ id, kind, status: queued\|running\|done\|error, exitCode: number\|null, log: string, error?: string }` (`log` = tail-capped joined output) |
| `/api/config` | GET | `?scope=` | `ConfigBundle` |
| `/api/config` | POST | `{ scope, updates: Record<key, value>, sync?: boolean }` | `200 ApplyResult`; `400` validation errors |
| `/api/roles` | GET | `?scope=` | `{ version, roles: [{ id, description, skillNamespaces, knowledgeNamespaces }], binding: { primaryRole, additionalRoles, resourceProfileVersion, stale }, effective: { skills: string[], knowledge: string[] } }` — `effective` via `resolveRoleResourceNamespaces`; `stale` = `manifest.version !== resourceProfileVersion` |
| `/api/roles/bind` | POST | `{ scope?, primaryRole?, additionalRoles? }` | `200 { binding, hint: 'changes take effect on next pull' }`; unknown role id ⇒ `400` + valid ids; implemented as `applyConfigPatch` on `primaryRole`/`additionalRoles` (registry validation reused) |
| `/api/resources` | GET | — | `{ skills: { count, items: [{ namespace, name, description, active, installed, excluded }] }, rules: { count, items: [{ namespace, name, active }] }, docs: { count, items: [{ name, title }] }, env: { count, items: [{ name, injectShellProfile }] }, agents: { count, items: [{ name, description }] }, hooks: { count, items: [{ name, description, autoApply, requireTeamScripts }] }, mcp: { count, items: [{ name }] }, culture: { present, path? }, roles: { count, ids }, recall: { indexStatus: fresh\|stale\|missing, entries: [{ title, path, domain, updatedAt }] } }` — enumeration via `getAllHandlers().scanTeamForPull()` + §5.9 specials. Lists capped at 500 items with `truncated: true` |
| `/api/resources/preview` | GET | `?type=&id=` | `{ type, id, path, content, truncated }` — content capped at 200 KB. `type=env` ⇒ **`403`** always. Dual gate: (a) `id` must match an item from the `/api/resources` scan (whitelist), (b) resolved path must pass `assertSafePath(resolved, [allowedRootFor(type)])`. allowedRoots: skill→`<repo>/skills`, rule→`<repo>/rules`, doc→`<repo>/docs`, agent→`<repo>/agents`, hook→`<repo>/hooks`, mcp→inline (no fs), culture→`<repo>/culture.md`, role→`<repo>/roles.yaml`, learning→`<repo>/learnings` |
| `/api/recall/search` | GET | `?q=&limit=` | `{ status: fresh\|rebuilt\|missing, results: [{ title, path, score, snippet }] }` — `loadIndex` + `search` (reuse `src/recall.ts` path resolution); missing/legacy index ⇒ one `buildIndex` attempt with a 30 s cap, else `status:'missing'` + hint to run `teamai recall` |

No SSE in v1 (job polling only). 404 JSON for unknown routes.

### 5.6 Job runner — `src/config-ui-jobs.ts`

```ts
export interface Job { id: string; kind: 'reinit' | 'sync';
  status: 'queued' | 'running' | 'done' | 'error';
  exitCode: number | null; log: string; error?: string; }

export interface SpawnRunner { (args: string[], opts: { cwd: string }):
  Promise<{ code: number; output: string }>; }

export function resolveCliEntry(): string
// process.argv[1], overridable via env TEAMAI_CONFIG_UI_CLI (tests / tsx dev mode)

export function createJobRunner(spawnImpl: SpawnRunner = defaultSpawn)
// defaultSpawn: child_process.spawn(process.execPath, [resolveCliEntry(), ...args],
//   { cwd, env: process.env }) capturing stdout+stderr into a ring buffer (cap 8000
//   lines, keep tail). One job at a time: further starts ⇒ error 'busy' (HTTP 409).
```

**`reinit` sequence** (kind `'reinit'`, exactly this order):
1. Load current config for scope (autoDetect when unspecified); not initialized ⇒ fail.
2. Branch resolution: `branch: string` must ∈ `ls-remote --heads` whitelist (ref-injection
   guard — user input never passed to git raw args otherwise); `branch: null` ⇒ target
   `state.teamRepoDefaultBranch`, else current origin/HEAD symref target.
3. Snapshot default branch once: if `state.teamRepoDefaultBranch` unset, parse
   `git ls-remote --symref origin HEAD` (`ref: refs/heads/<b>`) and `saveStateForScope`.
4. Dirty check: `git status --porcelain` in `localPath`; non-empty and `!force` ⇒ fail
   with dirty file list (HTTP 409 before job start). With `force`: proceed (mirror
   semantics, same as divergence heal in `ensureBranchState`; discarded commits stay in
   reflog — the job log lists the first 5).
5. Spawn init: `[cli, 'init', <remote>, '--branch', <b>]` (omit `--branch` when
   returning to default) `+ ['--scope', scope, '--force']`
   `+ ['--role', primaryRole]` when set
   `+ ['--agent', enabledAgents.join(',')]` when non-empty.
   Non-TTY subprocess ⇒ init's non-interactive escape engages automatically.
6. Spawn sync: `[cli, 'pull', '--force']`.
7. Job done with both exit codes in log; any step non-zero ⇒ `status:'error'`.

**`sync` sequence**: single `pull --force` spawn.

### 5.7 Frontend — `src/config-ui-html.ts`

Single HTML template literal. Six tabs; header shows connection/server title.
Reuse from `dashboard-html.ts`: CSS `:root` variables, `escapeHtml`, `escapeAttr`,
markdown renderer (`renderMarkdown`), card/table styling.

- **Repo**: key/value card + health badges + (when uninitialized) a bootstrap form
  (repo URL + scope) that shells to guidance text for `teamai init` (v1 does not
  POST an arbitrary repo URL — see §7.4).- **Branches**: table (name/sha/current/default markers) + actions
  `Re-init with selected branch` (confirm dialog shows: branch, scope, preserved
  role/agents, dirty-tree warning) → POST reinit → poll job → render log tail live
  (`<pre>` auto-scroll) → refresh Repo/Branches on done.
- **Roles**: table (id/description/skillNamespaces/binding-state), binding editor
  (primaryRole select + additionalRoles chips from `/api/roles`), Save → POST bind →
  banner "takes effect on next pull" + `Sync now` button; `stale` badge when
  `resourceProfileVersion` mismatch.
- **Resources**: type chips with counts (skills/rules/docs/env/agents/hooks/mcp/
  culture/roles/recall) → per-type table with status badges; click row → preview
  drawer (markdown render for SKILL.md/rules/docs/culture; code highlight otherwise);
  **env rows show name + policy only, never values**; recall section: index-status
  badge, entries table, search box → results (title/score/snippet) → click to preview.
- **Settings**: registry-driven form grouped by `group` (enum→select incl. dynamic
  options, boolean→switch, boolean-tri→3-way, string[]→chips); unsaved-changes diff
  panel (old → new per key); Save → POST config → inline per-key errors; tri-state
  and scope switcher (user/project) at top.
- **Sync**: state key/values + `Sync now` (job poll).

WebUI 界面文案以**中文**为主（2026-09-02 用户明确要求"界面显示需要以中文为主"，
覆盖本设计先前的英文文案约定；CLI 输出、代码注释、API 报错仍为英文，符合仓库
"CLI user-facing output must be in English" 规则）。XSS discipline: every
interpolated value goes through `escapeHtml`/`escapeAttr`.

### 5.8 Preview & scan specials

- culture.md: read `<repo>/culture.md` if present.
- roles: `loadRolesManifest(repoPath)`.
- recall entries: from the search index entries (title/path/domain/updatedAt as
  available from `loadIndex`).
- env values are **never** included anywhere in any response (scan, preview, logs).

---

## 6. Reuse map (do NOT re-implement)

| Need | Call |
|---|---|
| Config read/write per scope | `src/config.ts` (`loadLocalConfigForScope`, `saveLocalConfigForScope`, `loadStateForScope`, `saveStateForScope`, `autoDetectInit`) |
| Validation | `LocalConfigSchema` / `TeamaiConfigSchema` (`src/types.ts`) |
| Branch pin / health / default | `src/utils/branch-manager.ts` (`pinCloneToBranch`, `ensureBranchState`, `configuredBranch`, `BranchVanishedError`), `createGit` from `src/utils/git.ts` |
| Roles | `src/roles.ts` (`loadRolesManifest`, `listRoleIds`, `findRole`, `resolveRoleResourceNamespaces`) |
| Resource enumeration | `src/resources/index.ts` `getAllHandlers()` → `handler.scanTeamForPull(teamConfig, localConfig)`; `listDirs`/`listFiles`/`readFileSafe` from `src/utils/fs.ts` |
| Recall | `src/utils/search-index.ts` (`loadIndex`, `buildIndex`, `search`, `isLegacyIndex`); index path resolution per `src/recall.ts:285` |
| Recall on/off side effect | `src/recall-toggle.ts` exported enable/disable routines |
| Hooks policy | `getHooksSharing` (`src/types.ts`), `HooksHandler` |
| Path safety | `assertSafePath` (`src/utils/path-safety.ts`) |
| Locking precedent | pattern of `src/utils/import-lock.ts` (job mutex) |
| SKILL.md/rule front matter | `gray-matter` |
| HTML/markdown/escape | `src/dashboard-html.ts` internals (copy, don't import — it exports only `getDashboardHtml`; extract shared helpers into `src/utils/html.ts` **only if** trivial, otherwise duplicate ~80 lines and note the duplication) |
| Git ops in clone | `simple-git` via `createGit` (`src/utils/git.ts`) |

---

## 7. Security requirements (checklist — each item gets a test)

1. Server binds `127.0.0.1` only; assert with a LAN-interface connect refusal test
   (bind check on `0.0.0.0` connect from another local IP is environment-dependent —
   at minimum assert `server.address().address === '127.0.0.1'`).
2. No CORS header; cross-`Origin` POST ⇒ 403; evil `Host` ⇒ 403.
3. env values never serialized (scan + preview 403 + job logs); test greps the raw
   response bodies of `/api/resources` and `/api/resources/preview?type=env`.
4. Preview dual gate: non-whitelisted id ⇒ 404; `../` traversal ⇒ 404; symlink
   escape (temp fixture with symlinked file) ⇒ rejected by `assertSafePath`; 200 KB cap.
5. Branch names validated against `ls-remote` output (no git arg injection); remote
   for reinit is pinned to the currently configured `repo.remote` — the API accepts
   **no** repo URL parameter (bootstrapping a different repo stays with the CLI).
6. Job mutex: second concurrent start ⇒ 409; job subprocess runs with inherited env
   (git credentials resolved by git itself; UI never touches tokens).
7. All writes go through `applyConfigPatch` (zod rejects unknown keys) — no ad-hoc
   YAML writes anywhere in the UI layer.

---

## 8. Tests (vitest, `src/__tests__/`, hermetic via temp HOME/fixture repos)

| File | Covers |
|---|---|
| `config-fields.test.ts` | registry coverage: every optional/editable `LocalConfigSchema` key classified exactly once; no duplicate keys; static enums match schema |
| `config-service.test.ts` | patch merge + tri-state handling + zod errors per key; `afterSave` invoked after persist (recall toggle called with tmp dirs; branch pin called with right args — mock at module boundary); project/user source resolution |
| `config-ui-server.test.ts` | `createConfigUiServer(deps)` factory on port 0: routes happy paths; 404 JSON; Origin/Host guards; body limit; no CORS header; `/api/repo` shape against a fixture clone |
| `config-ui-jobs.test.ts` | injectable `spawnImpl`: reinit order (init → pull), `--branch` omitted for default, dirty-check 409 payload, busy 409, log tail cap, error propagation |
| `resources-scan.test.ts` | fixture team repo with all types: counts/items correct; skills active/inactive from role namespaces; env items name-only |
| `preview-security.test.ts` | whitelist miss, traversal, symlink escape, size cap, env 403 |
| `roles-api.test.ts` | bind validation (unknown id 400 + valid list), stale flag, effective namespaces |
| `recall-api.test.ts` | search on a small fixture index; missing index → `missing` + hint |

Factory/DI seams required: `createConfigUiServer({ port?, jobs?, serviceDeps? })`
and `createJobRunner(spawnImpl)` — keep route handlers thin so tests inject temp
paths (`TEAMAI_HOME`-style env overrides already used by the existing suite).

---

## 9. Milestones (each independently green: `npm run build` + `npx tsc --noEmit` +
full `npx vitest run` pass)

### M1 — Registry + service + CLI (~1 day)
`config-fields.ts`, `config-service.ts`, `config-cmd.ts`, `index.ts` registration,
`types.ts` port constant, `config-fields.test.ts`, `config-service.test.ts`.
**Accept**: `teamai config list/get/set` work end-to-end against a real initialized
install; `set recallEnabled false` actually removes recall artifacts (reuse path).

### M2 — Read-only WebUI (~1.5 days)
`config-ui.ts` GET routes + guards, `config-ui-html.ts` six tabs (read-only),
`/api/repo`, `/api/repo/branches`, `/api/roles`, `/api/resources`, preview, recall
search; server/jobs/resources/preview-security/roles-api/recall-api tests.
**Accept**: browser at `:3722` shows real data for the developer's install;
security tests green.

### M3 — Write paths + jobs (~2 days)
POST routes (`/api/config`, `/api/roles/bind`, `/api/repo/reinit`, `/api/sync`),
`config-ui-jobs.ts`, `StateSchema.teamRepoDefaultBranch`, afterSave wiring
(pin, recall toggle), frontend write interactions (diff preview, job log console,
bind editor, settings form).
**Accept**: full branch switch via UI on a fixture repo; settings save with inline
zod errors; concurrency 409; §8 all green.

### M4 — Docs + packaging + real e2e (~1 day)
Bilingual docs (§11), `npm run build` + `git add -f dist && git commit` (release-branch
convention: dist is tracked on `release/*` lines), run the §10 checklist against the
real GitLab teamai-demo repo, commit hygiene.

---

## 10. Real-repo e2e checklist (M4, GitLab `172.16.1.23:28080/huangweizhao/teamai-demo`)

1. `npm run build && node dist/index.js config ui --port 3722` inside a project with
   project-scope teamai installed.
2. **Repo** tab shows remote/provider/branch/health matching `.teamai/config.yaml`.
3. Create a test branch on GitLab (e.g. `webui-e2e`) with one added + one removed
   skill; **Branches** lists it; select it → Re-init → job log streams → done.
4. Verify post-reinit: `config.yaml` `repo.branch` updated; clone checked out on the
   branch; origin/HEAD repointed; added skill installed, removed skill cleaned
   (ledger diff); `enabledAgents` tools still injected.
5. **Branches** → switch back to default → repeat verification.
6. **Roles**: switch `primaryRole` to another manifest role → banner → Sync now →
   skills swapped per namespace; switch back.
7. **Resources**: counts match `ls` in the clone; preview a skill (markdown) and a
   hook (code); `../`-style and symlink probes rejected; env shows names only —
   `curl -s …/api/resources | grep -F <a-known-env-value>` finds nothing.
8. **Recall**: search box top hit equals `node dist/index.js recall <same query>` top hit.
9. **Settings**: add `excludedSkills` entry → `config.yaml` diff as expected; set an
   invalid value → inline error, file unchanged.
10. Security: `curl -H 'Origin: http://evil.example' -X POST …/api/config` ⇒ 403;
    server unreachable via the machine's LAN IP.

---

## 11. Docs obligations (repo rule: bilingual sync)

- `README.md` + `README.zh-CN.md`: command table + "Configuration WebUI" section.
- `docs/usage-guide.md` + `docs/usage-guide.zh-CN.md`: new chapter (CLI get/set +
  UI six tabs + branch re-init flow + security posture).
- `grep -rn` for stale wording ("no web ui", old dashboard-only claims) before PR.

## 12. Constraints

- **Zero new npm dependencies.**
- CLI output / code / API messages in English; the WebUI HTML is the sanctioned
  Chinese-first exception (user decision, 2026-09-02 — see §5.7).
- Never modify team-repo files from the UI (read-only toward the clone).
- Follow `release/*` branch conventions: final `dist` rebuild committed with `-f`.
- Do not push the branch without explicit user instruction.
- M3 verify-items (resolve before coding M3): ① non-interactive `init` username
  source when `--force` overwrites an existing config (preserve from old config?);
  ② `pull --force` non-interactivity on conflicts; ③ `resolveCliEntry()` behavior
  under `tsx --watch` dev mode; ④ `buildIndex` latency cap adequacy.
