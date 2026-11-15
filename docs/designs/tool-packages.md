# Tool packages

> Status: Proposal — each family of AI coding tools moves into its own private workspace package; every tool definition implements one contract from `tool-core` and is read through one typed registry; the packages ship inside `teamai-cli`, and a team or a member adds a tool as an instance of a shipped one without a release.

Tracking: workflow-first (#1589), connected drivers (`docs/designs/connected-drivers.md`, proposed separately).

## Problem

The code for every tool teamai supports is spread across the repository by concern, not by tool:
- the `TOOLS` descriptor table (`src/tools.ts`), whose type check lists every table that must decide a new tool;
- launch adapters (`LAUNCH_ADAPTERS`);
- session platforms and session adapters (`src/session-flow/adapters/`);
- token formats (`src/token-usage/`);
- writers for MCP, hooks, rules, blocks and agents (`src/resources/` and others);
- version detectors and default paths (`src/types.ts`, `src/agent-version.ts`).

Adding or changing one tool touches many of them. Production modules, scripts, lint rules and tests read `TOOLS` directly. Gates such as `isToolId`, `sessionPlatformsOf`, `channelsOf` and `isLaunchTool` answer "unknown tool" for any other id. A team on an internal build or a fork of a supported tool waits for a release. Its only lever, `toolPaths`, replaces where skills, rules and agents go, but not launch, sessions or tokens.

Variants already show the shape of the fix. `tclaude` and `claude-internal` reuse Claude's launch adapter, transcript format, token format and MCP and hook formats, with their own home, command and session identity (`src/tools.ts:618`, `src/session-flow/adapters/platform-facts.ts:62`).

## Principle

- One package per tool family owns what only that family uses: its definitions, launch profiles, session adapters, token formats, sync formats, detection, tests and fixtures. A family is one vendor's variants of one product.
- What several families use lives in `tool-core`.
- The contract is per definition, because support differs inside a family: `qoder` launches and `qoder-cn` does not; `pi` and `omp` have separate launch adapters and only `pi` has a confined profile; `codebuddy` and `workbuddy` have separate session adapters.
- The app reads tools only through a typed registry of the shipped packages.
- A team or a member adds a tool as an instance of a shipped definition: data, not code.
- Every package is private and bundled into `teamai-cli`, so there is no version matrix and no code loaded from outside.

## Layout

```text
packages/
├── shared/                        # helpers no domain owns, such as redact (secret masking); imports no other package
├── tool-core/                     # the contract and what several families share
│   ├── package.json               # "private": true, "exports": { "./definition", "./launch", "./sessions", … }
│   └── src/
│       ├── definition.ts          # ToolDefinition, ToolFamily, and the definition schema
│       ├── launch.ts              # LaunchProfile: today's call / step / confined profiles, moved
│       ├── sessions.ts            # SessionPlatform, SessionAdapter (today's AgentAdapter), store resolution
│       ├── tokens.ts              # UsageFormat and its input forms (session file, shutdown events)
│       ├── instance.ts            # an instance: a name, command, home and paths over a shipped definition
│       ├── registry.ts            # makeToolRegistry(families, instances) → lookups, gates, shipped-only view
│       ├── formats/               # formats more than one family uses:
│       │                          #   claude-code transcripts + claude-jsonl tokens (claude, qoder),
│       │                          #   codex rollouts (codex, joycode), the Claude result and plain reply readers,
│       │                          #   the claude MCP / hook / block formats (claude, kiro, trae, zcode, omp, …)
│       └── errors.ts
├── tool-claude/                   # claude, claude-internal, tclaude
│   ├── package.json
│   └── src/
│       ├── index.ts               # export const family = { definitions } as const satisfies ToolFamily
│       ├── facts.ts               # the `./facts` entry: definitions, session platform facts, version detectors; data only
│       ├── definitions.ts         # the three definitions (data + the formats they select)
│       ├── launch.ts  launch.test.ts   # the claude launch profile
│       ├── sync.ts    sync.test.ts     # writers only Claude uses (agents)
│       ├── detect.ts                   # version detector
│       └── fixtures/                   # recorded transcripts and stdout
├── tool-codex/                    # codex, codex-internal, tcodex
├── tool-pi/                       # pi and omp: one session format, two launch profiles, confined on pi only
├── tool-codebuddy/                # codebuddy, workbuddy, and the codebuddy-ide platform: three session adapters
├── tool-qoder/  tool-trae/        # qoder (launches) + qoder-cn (launch: none), trae + trae-cn
├── tool-opencode/  tool-cursor/  tool-copilot/  tool-kiro/  tool-muse/  tool-agy/
├── tool-openclaw/  tool-hermes/  tool-dsh/  tool-joycode/  tool-zcode/
├── tool-definitions/
│   └── src/registry.ts            # BUILT_IN_TOOLS: the ordered, literal list of every family
│       facts.ts                   # BUILT_IN_FACTS: every family's `./facts`, the part startup loads
└── tool-testing/
    └── src/
        ├── fake-cli.ts            # a fake tool executable that records argv, env and stdin and prints recorded stdout
        ├── replay-transcript.ts   # writes a recorded transcript into a session store
        └── conformance.ts         # the suite every family runs against each of its definitions
```

- **Package rules:**
  - Each package exports only what its `exports` map lists.
  - A family package depends on `tool-core` and on no other family.
  - `tool-definitions` is the only package that imports the families.
  - The app imports `tool-definitions` and `tool-core`, never a family directly.
  - Startup (the CLI entry, the hook dispatch, `teamai pull`) reads a family only through `@teamai/tool-definitions/facts`; adapters, launch profiles, token readers and schemas load where first used (`teamai/family-facts`).
  - `shared` holds helpers that belong to no domain, such as `@teamai/shared/redact`. Any package and the app may import it, and it imports no other package.
- **Files:** one file per concept, tests beside the file they test (`*.test.ts`), fixtures in the package.
- **Enforcement:** a `teamai/*` lint rule enforces the import direction.

## Contract

```ts
// tool-core (shape, not final code)
export interface ToolDefinition {
  readonly id: string;                                   // 'qoder-cn'; kept literal by `as const satisfies`
  readonly descriptor: ToolDescriptor;                   // today's TOOLS entry without launch, sessions and command, which live only here
  readonly command?: string;                             // today's `executable`
  readonly home?: { readonly dir: string; readonly env?: string };
  readonly launch: LaunchProfile | 'none';               // qoder: a profile; qoder-cn: 'none'
  readonly sessions: readonly SessionPlatform[] | 'none' | 'unknown';
  readonly tokens?: UsageFormat;
  readonly detect?: VersionDetector;
}

export interface LaunchProfile {                         // today's LaunchAdapter, whole (adapters.ts:62)
  readonly call: CallLaunch;                             // prompt transport (stdin | file | argv), stdin encoding, args, and
                                                         //   read(output): the answer or a failure (Pi exits 0 on a provider error)
  readonly step?: StepLaunch;                            // workflow steps, with the unattended args and their evidence
  readonly confined?: ConfinedLaunch;                    // a run confined to one directory: env, homeEnv, verified versions, access (pi, not omp)
}

export interface SessionPlatform {                       // one session identity: 'tclaude', 'codebuddy-ide'
  readonly id: string;
  readonly store: StoreLocation;                         // a directory in a tool home, or a fixed location
  resume(sessionId: string): string;
  adapter(storeDir: string): SessionAdapter;             // list, read, existing id, subagents, write, delete, readiness
}

export interface ToolFamily {
  readonly definitions: readonly ToolDefinition[];
  readonly platforms?: readonly SessionPlatform[];       // stores no definition owns, such as codebuddy-ide
  readonly formats?: FormatTable;                        // sync formats only this family writes
}
```

- **Launch.** `CallLaunch`, `StepLaunch` and `ConfinedLaunch` move to `tool-core` as they are, with `ACCESS_LEVELS` (`ConfinedAccess`), which a confined profile declares; no second launch abstraction. A definition with only a call profile (Cursor) supplies no step.
- **Sessions.** `SessionAdapter` is today's `AgentAdapter` (`src/session-flow/adapters/base.ts`), writes and deletes included, because restore, migration and rollback use them (`agent-session.ts:359`). Read-only platforms stay read-only. Two definitions that share a format build the same adapter class with their own platform id, as `ADAPTER_REGISTRY` does today (`adapters/index.ts`), so their sessions are found, resumed, scored and published as their own.
- **Tokens.** `UsageFormat` keeps today's input forms: a session file for most, shutdown events for Copilot.
- **Literal ids.** Each family and `BUILT_IN_TOOLS` are declared `as const satisfies`, so `ToolId` and `SessionPlatform` stay literal unions derived from the registry, and the type tests that check them move with their owners.

## Shipped, team and personal tools

```yaml
# tools/acme-claude.yaml in the team repo; --tools default=acme-claude
schemaVersion: v1alpha1
name: acme-claude
extends: claude                    # an instance of the shipped `claude` definition
command: acme-claude               # the executable on PATH
home: { dir: .acme-claude, env: ACME_CLAUDE_CONFIG_DIR }
paths: { skills: .acme-claude/skills }   # the toolPaths keys
```

- **Shipped tools** are the definitions of the family packages. They keep their ids (`claude`, `codex`, …) and platform ids (`claude-code`, …), because session records, configs, `--tools` and `init --agent` already store them.
- **Instances.** A team or personal tool is an instance of a shipped definition that sets `instances: true` (`INSTANCE_BASES`: Claude Code and Codex today). A definition sets it only once every path teamai reads or writes for it resolves through the instance's home, `home.env` included. teamai refuses an instance of any other definition, so a family whose code still joins its own home by hand cannot receive one.
  - It may set `command`, `home` and `paths`, and nothing else. Its formats are the definition's, so one team cannot break session capture for every member.
  - Its session identity is its own name.
  - An instance named like a shipped tool adjusts that tool, again only for an `INSTANCE_BASES` definition; any other tool moves its paths with `toolPaths`. `paths` replaces the shipped paths whole, as `toolPaths` does today, and `doctor` names every key it dropped. A `toolPaths.<tool>` entry reads as that instance's `paths`.
- **Resolution** follows connected drivers D4:
  - first the member's own `~/.teamai/tools/<name>.yaml`;
  - then the project's team definition, with namespaces;
  - then the user scope's;
  - then the shipped one.

  teamai never writes into `~/.teamai/tools/`. Handed-over runs and fleet members ignore personal instances. User and workspace tuning goes under `tools.<name>`.
- **Trust.** Only an instance that sets `command` runs code on members' machines. Its first use with a given `command` and file content asks in an attended session; an unattended session refuses it until a person accepts that content. An instance that sets only `paths` or `home`, including a `toolPaths` entry read as one, needs no acceptance, as `toolPaths` needs none today. A personal instance is the member's own and needs no acceptance.
- **Runtimes.** On connected-driver runtimes, an instance's `home.env` is set to the attempt's tool home.

## Registry

- **What it holds.** `tool-definitions` builds `BUILT_IN_TOOLS` from the family packages, with every family's definitions and extra platforms, and `BUILT_IN_FACTS` (`@teamai/tool-definitions/facts`) from each family's facts entry alone. Adding a family to it, or a definition to a family, fails to compile until every table that must decide it does, as `TOOL_IDS` makes it today (`src/tools.ts:401`).
- **What reads it.** At load, the app builds one registry from `BUILT_IN_FACTS` and the resolved instances; a family's behaviour (`BUILT_IN_TOOLS`) loads where it is first needed. Every reader of a tool id or a session platform goes through it:
  - `pull`, `--tools`, launch, session find, migration, restore, token reading, `doctor` and the dashboard;
  - the gates `isToolId`, `sessionPlatformsOf`, `channelsOf` and `isLaunchTool`.
- **Fixed-id tables** (`LaunchedToolId`, `CodexToolId`, `SessionPlatform`, `DETECTORS`, `DEFAULT_TOOL_PATHS`, …) stay keyed by shipped definition or platform id, never collapsed to a family, so `tclaude` never merges into `claude`. An instance reaches them through the definition it extends; only its session identity is its own name, a validated instance platform id rather than a member of the union.
- **Orders.** `DEFAULT_TOOL_PATHS` order (the generated support page) and `LAUNCH_ORDER` (headless call fallback) are both kept; family order replaces neither.
- **Generated docs.** `docs/guide/tool-support.md` and the README matrix check read the registry's shipped-only view, so they never list instances.

## Build and workspace

- **Workspaces.** The repository gains npm workspaces for `packages/*`, and the root scripts reach every package: `npm run build`, `npm run typecheck`, `npm run lint`, `npx vitest run`.
- **Bundling.** tsup already bundles every dependency but `web-tree-sitter` into `teamai-cli` (`tsup.config.ts:63`), so the workspace packages are bundled with no config change. Nothing new is published. The connected-driver runtimes use the same workspace and ship as their own executables in the `teamai-cli` package.
- **Lint.** Production-scoped `oxlint-plugin-teamai` rules check only paths under `src/` today (`inProductionSource`, `oxlint-plugin-teamai/utils.js:63`); batch 1 extends them to `packages/*/src/`.
- **Tests.** Each package's tests run under the root Vitest config.

## Migration

Built-in tools move in bounded batches. Each batch is green on its own: `npm run typecheck`, `npm run lint`, the affected unit and E2E suites, and `node scripts/check-docs.mjs` with no diff to the generated support page, `commands.md` and the README matrix. No batch changes behavior a user sees. The old form goes only once no reader of it remains.

| Batch | Moves | Extra proof |
|---|---|---|
| 1 | Workspaces wired into build, typecheck, lint and tests; production-scoped lint rules cover `packages/*/src/` (tests excluded); `tool-core` with `makeToolRegistry`. Until a family moves, the tables (`TOOLS`, launch adapters, `ADAPTER_REGISTRY`) stay in `src/`, which no package may import, so the app builds its registry in `src/tool-registry.ts` from `TOOLS`; `tool-definitions` arrives with the first family (batch 3). Every consumer of those tables is inventoried: production, type-only, scripts, lint rules. A lint rule rejects reading the raw tables outside the registry, with a baseline of the readers not yet moved; readers and the four gates move one module at a time | A seeded new bypass fails lint; a seeded violation inside a package fails lint; the bundle runs `teamai --help` |
| 2 | `teamai/tool-facts` moved off parsing the `TOOLS` source text (it matches `export const TOOLS = {` and checks nothing when that fails). `check-docs.mjs` writes the registry's shipped ids to a generated JSON and keeps it current; the rule reads it and fails when it is missing or empty | A seeded tool-fact violation still fails, in `src/` and in a package; a missing JSON fails |
| 3 | `tool-testing`, `tool-claude` and `tool-definitions`, whose `BUILT_IN_TOOLS` becomes the registry's input, with the shared Claude-shaped formats in `tool-core/formats`; launch, sessions, tokens, sync and detection moved with their tests and fixtures; `tool-claude` runs the conformance suite | Claude, `claude-internal` and `tclaude` keep their session identities and the locate matrix; qoder still reads its sessions |
| 4 | Every other family, a few per change, each running the conformance suite. `TOOLS`, the launch adapter table, `ADAPTER_REGISTRY` and the per-concern tables keep no rows of their own: each row is a `BUILT_IN_TOOLS` reference, in the order users see. They leave `src/` with `sessionStoreDir` and the readers still in the lint baseline (`src/locate.ts`, `src/session-flow/index.ts`), once the connected-drivers engine has landed | The same, per family; `codebuddy-ide` sessions still found |
| 5 | Team and personal instances; `toolPaths` read as `paths` | Slice 2 |

## Slices

Each slice ships its English and Chinese guide changes and one real-CLI run after `npm run build`. Slice 1 has no user-visible behavior, so the common checks and unchanged generated pages are its proof.

1. Batches 1–4 → verify:
   - the common checks pass at every batch, and the seeded bypass, package-lint and tool-fact violations fail;
   - each family passes the conformance suite for every definition: each launch profile it declares (and no other), its session adapters' read, plus a write and delete round trip only where the adapter writes today (Pi, Agy and Muse stay read-only), its token format;
   - the import-direction rule rejects a family importing another;
   - a `pull`, a workflow prompt step on Claude and on Codex, a headless call on Pi that hits a provider error, and a `session resume` restore behave as before.
2. Instances (batch 5) → verify, for a team instance extending `claude` with another command and home:
   - `--tools default=<instance>` accepts it, and `pull` delivers skills to its paths;
   - a workflow prompt step launches it with its own command;
   - run beside Claude with distinct homes, its session is found, resumed, scored and published as the instance's, not Claude's;
   - an unaccepted `command` is not run; an instance that sets only `paths` runs unattended without acceptance, and an unrelated team-repo commit does not ask again;
   - a member's personal instance of the same name replaces the team's for that member;
   - a team instance of `claude` that sets `paths` replaces a `toolPaths` entry, and `doctor` reports a dropped key;
   - an instance that sets a format key is refused.
3. Instances on connected-driver runtimes → verify: the same instance runs a prompt in a sandbox with its home variable set to the attempt's tool home, and `score --drain` publishes its session.

## Out of scope

- Instances that change a definition's formats.
- New families without a release.
- An external tool protocol for families teamai has no package for.
- Loading code from outside the bundle.
- Listing instances on the generated pages.
- The same layout for forge providers (`git`, `gitlab`, `github`, `gitcode`), which a later design covers.

## Risks to check

- Whether every shared format moves cleanly into `tool-core/formats`, or some format assumes one family's paths (a hooks writer that hard-codes `.claude`). Batch 3 finds out.
- Behavior still keyed by tool id outside the inventoried tables, such as agent rendering. Batch 1's inventory lists it; the batch that moves its family moves it.
- OpenCode's session adapter reads through the `opencode` executable and the host env, not only its store (`adapters/opencode.ts:461`); its package keeps that.
- Whether tsup bundling of workspace packages keeps today's single-file CLI start-up time; batch 1 measures `teamai --help` before and after.
