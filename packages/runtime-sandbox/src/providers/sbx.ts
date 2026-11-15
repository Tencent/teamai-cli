import crypto from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { Can, RuntimeFailure } from '@teamai/runtime-protocol';
import { mayBeRunning } from '@teamai/shared/process-group';
import type { JournalId } from '../journal.js';
import type { ProfileOption, WarmOptions } from '../options.js';
import { PROVIDER_COMMANDS } from '../provider-commands.js';
import { oneBuildPerKey, planWarm, savedWarm, scratchOf, WARM_REPOSITORY, warmFailed, type WarmPlan, type WarmRemoval } from '../warm.js';
import { COMMAND_MS, journalPrefixOf, journalSandboxName, placeOfJournalSandbox, type ExecEnd, type ExecSpec, type PlaceKey, type Provider } from '../provider.js';
import { offerSignedIn, type MissingCommand } from '../sign-in.js';
import { cliOf, commandsOf, definedOnly, heldProbe, signalled, LAUNCHABLE, mountsOf, WORKSPACES, type Ran } from './cli.js';

// ─── sbx (Docker Sandboxes) ──────────────────────────────
//
//  One microVM per attempt, from the agent's template, each place path at its host path through virtiofs:
//
//    sbx create --name teamai-<journal>-<run>-<attempt> --no-progress <template> <worktree> <result> <run dir> <tool home> <git path>:ro …
//    sbx exec -w <cwd> -e NAME … teamai-<journal>-<run>-<attempt> env -u WITHHELD … -- <argv>
//    sbx stop teamai-<journal>-<run>-<attempt>          ends every process; the next exec starts the sandbox again
//    sbx rm --force teamai-<journal>-<run>-<attempt>
//
//  With `warm`, each attempt's sandbox starts from the template teamai-warm:<key> (warm.ts, `create -t`), saved once per
//  key from the attempt's template:
//
//    sbx create --name teamai-<journal>-warm-<pid>-<random> --no-progress <template> <scratch>
//    sbx exec -w <scratch> teamai-<journal>-warm-<pid>-<random> /bin/sh -c <prepare>              no credential, with the network
//    sbx stop …; sbx template save teamai-<journal>-warm-<pid>-<random> teamai-warm:<key>; sbx rm --force …
//
//  The worktree is the primary workspace. sbx does not follow a linked worktree's `.git` to its common directory, so
//  the git paths the view names are mounted read-only at their own paths: `git status` works, `git commit` cannot
//  write. No credential goes in at create: each exec brings its own, by name, from this process's environment. A
//  login stored with `sbx secret set` stays in the host's proxy, which injects it into the requests; the sandbox holds
//  only the placeholder variables its agent reads, which an exec keeps unless teamai withholds them. The name is its
//  id: `sbx ls` finds it again after a restart. A sandbox carries no label (sbx 0.53.0 `create` takes none), so
//  its name carries the journal that owns it, the id a container's `teamai.owner` label carries, and an open sweeps the
//  sandboxes `sbx ls` lists under this journal's prefix as it sweeps containers by their label. sbx's network policy
//  lets a sandbox reach every host it allows, so this provider offers no judge, which must reach its model provider only.
//

/**
 * The agent template sbx ships for each tool teamai launches, when it ships one. With no `agent`, an attempt starts
 * from its own tool's, and a command step's from the bare `shell` template, which holds no agent.
 */
const TEMPLATE_OF = { claude: 'claude', codex: 'codex', codebuddy: undefined, opencode: 'opencode' } satisfies Record<(typeof LAUNCHABLE)[number], string | undefined>;

/** The tools sbx ships a template for, which a sandbox with no `agent` offers. */
const TEMPLATED = LAUNCHABLE.filter((tool) => TEMPLATE_OF[tool] !== undefined);

const NOT_INSTALLED = 'sbx is not installed here, or not on PATH. Install Docker Sandboxes (https://docs.docker.com/ai/sandboxes/), sign in with `sbx login`, and start again.';

/**
 * sbx's own settings, which it reads from its environment: an exec's names never replace them, so a step cannot point
 * the CLI at another home, daemon or proxy, and are never passed into the sandbox.
 */
const CLI_SETTING = /^(?:HOME|XDG_[A-Z_]+|SBX_[A-Z0-9_]*|DOCKER_[A-Z0-9_]*)$/;

const ListedSchema = z.array(z.looseObject({ name: z.string() }));

/** `sbx template ls --json`: each saved template's repository, tag and image id (sbx 0.51.0; the id as of 0.53.0). */
const TemplatesSchema = z.array(z.looseObject({ repository: z.string(), tag: z.string(), id: z.string().optional() }));

/** `sbx policy check network --json <target>`: whether the member's policy lets a sandbox reach it (sbx 0.51.0). */
const CheckedSchema = z.object({ allowed: z.boolean() });

/** `sbx secret ls --global --json`: the services sbx's proxy holds a login for. Each secret's masked value is never read. */
const StoredSchema = z.object({ secrets: z.array(z.object({ name: z.string() })) });

/**
 * Where an agent template keeps a tool's sign-in in its own home, by tool: the stand-in sbx's proxy swaps for the stored
 * login (sbx 0.51.0's claude template: `~/.claude/.credentials.json`). teamai points the tool's home variable, or an
 * instance's own, at the attempt's tool home, where the tool would find no sign-in, so the sandbox links it there.
 * Codex's template keeps none: it signs in from an OPENAI_API_KEY placeholder in its env.
 */
const TEMPLATE_SIGN_IN = { claude: '.claude/.credentials.json' } satisfies Partial<Record<(typeof LAUNCHABLE)[number], string>>;

/** The notice sbx prints on stderr when an exec starts a sandbox it stopped while idle: sbx's line, not the step's. */
const STARTED = /^[ \t]*✓ sandbox \S+ — started\r?\n/;

/**
 * The warm templates teamai saved (`teamai-warm:<key>`) that `sbx template ls --json` printed: the reference `sbx
 * template rm` takes (`<repository>:<tag>`, by tag as sbx 0.53.0's help shows it) and the key; undefined when it printed
 * something else.
 */
export function sbxWarmTemplatesListed(stdout: string): Array<{ ref: string; key: string; id?: string }> | undefined {
  return templatesNamed(stdout, WARM_REPOSITORY)?.map(({ ref, tag, id }) => ({ ref, key: tag, ...(id !== undefined && { id }) }));
}

/**
 * The templates sbx 0.53.0 assembled from a kit (`sandbox-kit-assembled:<hash>`) that `sbx template ls --json` printed,
 * sbx's own, made by any sandbox of a kit: a warm template saved from one shares its image id; undefined as above.
 */
export function sbxKitTemplatesListed(stdout: string): Array<{ ref: string; id?: string }> | undefined {
  return templatesNamed(stdout, KIT_REPOSITORY)?.map(({ ref, id }) => ({ ref, ...(id !== undefined && { id }) }));
}

/** The repository sbx 0.53.0 keeps the templates it assembled from kits under. */
const KIT_REPOSITORY = 'sandbox-kit-assembled';

/** The templates of repository `name`, bare or under a registry, that `sbx template ls --json` printed. */
function templatesNamed(stdout: string, name: string): Array<{ ref: string; tag: string; id?: string }> | undefined {
  try {
    const listed = TemplatesSchema.safeParse(JSON.parse(stdout));

    return listed.success ? listed.data.filter(({ repository }) => repository === name || repository.endsWith(`/${name}`)).map(({ repository, tag, id }) => ({ ref: `${repository}:${tag}`, tag, ...(id !== undefined && { id }) })) : undefined;
  } catch {
    return undefined;
  }
}

/** What sbx said: its `error: …` line and the `try: …` hint it adds, on one line. */
function messageOf(ran: Ran): string {
  return ran.kind !== 'ran' ? ran.message : ran.stderr.trim().split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('✓')).slice(-2).join('; ');
}

/** The sandbox names `sbx ls --json` printed, or undefined when it printed something else. */
export function sbxNamesListed(stdout: string): string[] | undefined {
  try {
    const listed = ListedSchema.safeParse(JSON.parse(stdout));

    return listed.success ? listed.data.map(({ name }) => name) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `owner`: the id of the journal whose attempts the sandboxes are, which starts each one's name. `agent`: the template
 * or kit every sandbox starts from; unset, each attempt's tool picks its template. `warm`: the recipe of the warm
 * template each attempt starts from, saved from that template.
 */
export function sbxProvider({ agent, owner, env, warm, profile, state }: { agent: string | undefined; owner: JournalId; env: NodeJS.ProcessEnv; warm?: Extract<WarmOptions, { prepare: string }>; profile?: ProfileOption; state: string }): Provider {
  const { run: cli, executable } = cliOf({ name: PROVIDER_COMMANDS.sbx, env, notInstalled: NOT_INSTALLED });
  const records = savedWarm(warmRecords(state));

  /** `sbx exec`'s arguments and environment: the spec's names by name only, never sbx's own settings, which stay. */
  const execOf = (id: string, spec: ExecSpec, { isInteractive }: { isInteractive: boolean }) => {
    const passed = Object.keys(spec.env).filter((variable) => !CLI_SETTING.test(variable));
    const withheld = spec.unset.length > 0 ? ['env', ...spec.unset.flatMap((variable) => ['-u', variable]), '--'] : [];

    return {
      args: ['exec', ...(isInteractive ? ['-i'] : []), '-w', spec.cwd, ...passed.flatMap((variable) => ['-e', variable]), id, ...withheld, ...spec.argv],
      env: { ...env, ...Object.fromEntries(passed.map((variable) => [variable, spec.env[variable]])) } satisfies NodeJS.ProcessEnv,
    };
  };

  /** What starts the name of every sandbox of this journal. */
  const journalPrefix = journalPrefixOf(owner);

  /** An attempt's sandbox name, which is also its id: `teamai-<journal>-<run>-<attempt>`. */
  const nameOf = (key: PlaceKey): string => journalSandboxName(owner, key);

  const unavailable = (message: string) => ({ ok: false, failure: { code: 'sandbox_unavailable', message } }) satisfies { ok: false; failure: RuntimeFailure };

  /** Every sandbox name `sbx ls --json` lists, within COMMAND_MS, or what sbx said instead. */
  const list = async (): Promise<{ ok: true; names: string[] } | { ok: false; message: string }> => {
    const ran = await cli(['ls', '--json'], { timeoutMs: COMMAND_MS, isListing: true });
    const names = ran.kind === 'ran' && ran.code === 0 ? sbxNamesListed(ran.stdout) : undefined;

    return names !== undefined ? { ok: true, names } : { ok: false, message: messageOf(ran) || 'it printed no list' };
  };

  const find: Provider['find'] = async (key) => {
    const listed = await list();
    const name = nameOf(key);

    if (listed.ok) return { ok: true, id: listed.names.includes(name) ? name : undefined };

    return { ok: false, failure: { code: 'sandbox_failed', message: `sbx could not list its sandboxes: ${listed.message}. Sandbox ${name} stays this attempt's until sbx answers again (\`sbx daemon start\`); to remove it now, run \`sbx rm --force ${name}\`.` } };
  };

  const remove = async (name: string): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }> => {
    const removed = await cli(['rm', '--force', name], { timeoutMs: COMMAND_MS });

    if (removed.kind === 'ran' && (removed.code === 0 || /not found/i.test(removed.stderr))) return { ok: true };

    return { ok: false, failure: { code: 'sandbox_failed', message: `sbx could not remove sandbox ${name}: ${messageOf(removed)}. Remove it with \`sbx rm --force ${name}\`.` } };
  };

  /**
   * The tools a kit (or an agent other than claude and codex) brings, and which of `commands` it holds, from a scratch
   * sandbox with no workspace.
   */
  const probeTools = async (kit: string, commands: string[]): Promise<{ ok: true; tools: string[]; held: ReadonlySet<string> } | { ok: false; failure: RuntimeFailure }> => {
    const scratch = `teamai-tools-${crypto.randomBytes(4).toString('hex')}`;
    const created = await cli(['create', '--name', scratch, '--no-progress', kit]);

    if (created.kind !== 'ran' || created.code !== 0) return unavailable(`sbx could not create a sandbox from agent ${kit} (${messageOf(created)}). Check the agent name or kit reference, and start again.`);
    const probe = await cli(['exec', scratch, '/bin/sh', ...heldProbe([...LAUNCHABLE, ...commands])]);
    const removed = await remove(scratch);

    if (!removed.ok) return { ok: false, failure: { code: 'sandbox_unavailable', message: removed.failure.message } };

    if (probe.kind !== 'ran' || probe.code !== 0) return unavailable(`sbx could not run a command in a sandbox from agent ${kit} (${messageOf(probe)}). Check that its template runs /bin/sh, and start again.`);
    const found = new Set(probe.stdout.split('\n').map((line) => line.trim()));

    return { ok: true, tools: LAUNCHABLE.filter((tool) => found.has(tool)), held: found };
  };

  /**
   * Links, inside sandbox `name`, the sign-in its template keeps for the attempt's `tool` into the attempt's tool home,
   * under whichever variable moves it there (an instance's own included), unless that home already holds one. Only a
   * link lands on the host's disk, pointing into the sandbox.
   */
  const linkSignIns = async (name: string, toolHome: Record<string, string>, tool: string | undefined): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }> => {
    const file = Object.entries(TEMPLATE_SIGN_IN).find(([launched]) => launched === tool)?.[1];
    const links = file === undefined ? [] : Object.values(toolHome).flatMap((dir) => [file, dir]);

    if (links.length === 0) return { ok: true };
    const script = 'while [ $# -gt 0 ]; do f="$HOME/$1" t="$2/$(basename "$1")"; if [ -e "$f" ] && [ ! -e "$t" ] && [ ! -L "$t" ]; then ln -s "$f" "$t" || exit 1; fi; shift 2; done';
    const ran = await cli(['exec', name, '/bin/sh', '-c', script, 'sh', ...links], { timeoutMs: COMMAND_MS });

    if (ran.kind === 'ran' && ran.code === 0) return { ok: true };

    return { ok: false, failure: { code: 'sandbox_failed', message: `sbx could not give the tool in sandbox ${name} the login sbx keeps for it: ${messageOf(ran) || 'the link failed'}. Remove it with \`sbx rm --force ${name}\`, and start again.` } };
  };

  /** The template an attempt of `tool` starts from: the agent's, else the tool's own, or none sbx ships for it. */
  const templateOf = (tool: string | undefined): string | undefined => {
    const launched = LAUNCHABLE.find((each) => each === tool);

    return agent ?? (tool === undefined ? 'shell' : launched && TEMPLATE_OF[launched]);
  };

  const once = oneBuildPerKey<{ ok: true } | { ok: false; failure: RuntimeFailure }>();

  /** sbx's version, which keys a warm template with the template it is saved from: a new sbx ships new templates. */
  let version: Promise<string> | undefined;

  const sbxVersion = (): Promise<string> => {
    version ??= cli(['version'], { timeoutMs: COMMAND_MS }).then((ran) => (ran.kind === 'ran' && ran.code === 0 ? ran.stdout.trim() : 'unknown'));

    return version;
  };

  /** Whether sbx keeps the warm template of `plan` already; a list sbx cannot give is taken as not, so it is saved again. */
  const isSaved = async (plan: WarmPlan): Promise<boolean> => {
    const ran = await cli(['template', 'ls', '--json'], { timeoutMs: COMMAND_MS, isListing: true });
    const saved = ran.kind === 'ran' && ran.code === 0 ? sbxWarmTemplatesListed(ran.stdout) : undefined;

    return saved?.some(({ key }) => key === plan.key) ?? false;
  };

  /** Saves the warm template of `plan` from `template`, prepared in a scratch sandbox on copies of the `cache` files. */
  const makeWarm = async (plan: WarmPlan, template: string, prepare: string): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }> => {
    const scratch = scratchOf(plan.cache);
    const name = `${journalPrefix}warm-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;


    try {
      const created = await cli(['create', '--name', name, '--no-progress', template, scratch.dir]);

      if (!(created.kind === 'ran' && created.code === 0)) return warmFailed(`sbx could not create a sandbox from ${template} to prepare the warm template ${plan.tag}`, created);
      const prepared = await cli(['exec', '-w', scratch.dir, name, '/bin/sh', '-c', prepare]);

      if (!(prepared.kind === 'ran' && prepared.code === 0)) return warmFailed(`The warm template's prepare, \`${prepare}\`, failed in a sandbox from ${template}`, prepared);
      const stopped = await cli(['stop', name], { timeoutMs: COMMAND_MS });

      if (!(stopped.kind === 'ran' && stopped.code === 0)) return warmFailed(`sbx could not stop sandbox ${name} to save the warm template ${plan.tag}`, stopped);
      const saved = await cli(['template', 'save', name, plan.tag]);

      return saved.kind === 'ran' && saved.code === 0 ? { ok: true } : warmFailed(`sbx could not save the warm template ${plan.tag}`, saved);
    } finally {
      await remove(name);
      scratch.remove();
    }
  };

  /**
   * The `-t` an attempt in `checkout` from `template` is created with: the warm template. `warm` saves it first when it is
   * not there; the creation of a sandbox, which a close waits for, only names the one `warm` saved, so a close never
   * waits on a build.
   */
  const warmFrom = async (template: string, checkout: string, { creating = false }: { creating?: boolean } = {}): Promise<{ ok: true; args: string[] } | { ok: false; failure: RuntimeFailure }> => {
    if (warm === undefined) return { ok: true, args: [] };
    const planned = planWarm({ base: `${template}@${await sbxVersion()}`, recipe: warm, checkout, ...(profile && { profile }) });

    if (!planned.ok) return planned;
    const { plan } = planned;

    // sbx itself refuses a template removed since, which the creation's failure then names.
    if (creating) return { ok: true, args: ['-t', plan.tag] };

    const made = await once(plan.key, async () => {
      if (await isSaved(plan)) return { ok: true };
      const built = await makeWarm(plan, template, warm.prepare);

      if (built.ok) records.record(plan.tag);

      return built;
    });

    return made.ok ? { ok: true, args: ['-t', plan.tag] } : made;
  };

  /** The services whose login sbx's proxy holds for every sandbox, which it injects into a tool's requests. */
  const storedLogins = async (): Promise<{ ok: true; services: ReadonlySet<string> } | { ok: false; failure: RuntimeFailure }> => {
    const ran = await cli(['secret', 'ls', '--global', '--json'], { isListing: true });
    let parsed: z.infer<typeof StoredSchema> | undefined;

    try {
      parsed = ran.kind === 'ran' && ran.code === 0 ? StoredSchema.parse(JSON.parse(ran.stdout)) : undefined;
    } catch {
      parsed = undefined;
    }

    if (parsed === undefined) return unavailable(`sbx could not list the logins it keeps (${messageOf(ran) || 'it printed no list'}). Run \`sbx secret ls\` to see why, and start again.`);

    return { ok: true, services: new Set(parsed.secrets.map(({ name }) => name)) };
  };

  /** Whether sbx's daemon answers and its network policy is set, without which it creates no sandbox. */
  const reachable = async (): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }> => {
    const ls = await cli(['ls', '--json']);

    if (ls.kind !== 'ran') return unavailable(ls.message);

    if (ls.code !== 0) return unavailable(`sbx cannot reach its daemon (${messageOf(ls)}). Run \`sbx daemon start\`, or \`sbx login\` if you are signed out, and start again.`);
    const policy = await cli(['policy', 'ls']);

    if (policy.kind === 'ran' && /not been initialized/i.test(policy.stderr)) {
      return unavailable('sbx creates no sandbox until its network policy is set. Run `sbx policy init balanced` once (or `sbx policy init deny-all` and allow your model provider with `sbx policy allow network <host>`), and start again.');
    }

    return { ok: true };
  };

  return {
    family: 'bind',
    reachable,
    async offer(credentials, instances) {
      const reached = await reachable();

      if (!reached.ok) return reached;

      const template = LAUNCHABLE.find((tool) => tool === agent);
      const found = agent === undefined ? { ok: true as const, tools: [...TEMPLATED], held: undefined } : template !== undefined ? { ok: true as const, tools: [template], held: undefined } : await probeTools(agent, commandsOf(instances));

      if (!found.ok) return found;
      const { held } = found;

      // A kit was looked in; sbx's own templates hold only their agent, so an instance's command is there only when it is
      // that agent's.
      const missing: MissingCommand = (command, tool) => {
        if (held !== undefined) return held.has(command) ? undefined : { holder: `kit ${agent}`, fix: 'add it to the kit' };
        const launched = LAUNCHABLE.find((each) => each === tool);
        const own = template ?? (launched && TEMPLATE_OF[launched]);

        if (own === undefined) return { holder: 'any template sbx ships', fix: 'set agent to a kit that brings it' };

        return command === own ? undefined : { holder: `sbx's ${own} template`, fix: 'set agent to a kit that brings it' };
      };

      const stored = await storedLogins();

      if (!stored.ok) return stored;
      const { tools, unavailable: notSignedIn, kept, unusedGateways } = offerSignedIn({ tools: found.tools, provider: 'sbx', credentials, stored: stored.services, env, instances, missing });
      const can: Can = { workspace: WORKSPACES, isolation: 'sandbox', env: true, tokens: true, max_turns: true, setup: true, tools, end_turn: true, unattended: true, role: true };

      // sbx's proxy answers host.docker.internal as this machine's localhost, which its policy then allows or refuses.
      return { ok: true, can, host: { ok: true, alias: 'host.docker.internal' }, unavailable: notSignedIn, ownLogins: kept, unusedGateways };
    },

    find,

    async reachesHost(port, variable) {
      const rule = `\`sbx policy allow network localhost:${port}\``;
      const ran = await cli(['policy', 'check', 'network', '--json', `localhost:${port}`], { timeoutMs: COMMAND_MS });
      let checked: z.infer<typeof CheckedSchema> | undefined;

      try {
        checked = ran.kind === 'ran' ? CheckedSchema.parse(JSON.parse(ran.stdout)) : undefined;
      } catch {
        checked = undefined;
      }

      if (checked?.allowed === true) return { ok: true };

      if (checked?.allowed === false) return unavailable(`${variable} points at port ${port} of this machine, which your sbx network policy does not let a sandbox reach. Allow it once with ${rule}, and start again.`);

      return unavailable(`sbx could not tell whether your network policy lets a sandbox reach port ${port} of this machine, which ${variable} points at (${messageOf(ran) || 'it printed no answer'}). If it does not, allow it with ${rule}, and start again.`);
    },

    async owned() {
      const listed = await list();

      if (!listed.ok) return { ok: false, failure: { code: 'sandbox_failed', message: `sbx could not list the sandboxes this runtime's journal owns: ${listed.message}` } };

      return {
        ok: true,
        sandboxes: listed.names.flatMap((name) => {
          const place = placeOfJournalSandbox(name);

          return place?.owner === owner ? [{ id: name, ...place.key }] : [];
        }),
        // sbx runs here, so a scratch sandbox's pid is of this machine.
        leftWarm: listed.names.filter((name) => {
          const pid = name.startsWith(journalPrefix) ? /^warm-(\d+)-[0-9a-f]+$/.exec(name.slice(journalPrefix.length))?.[1] : undefined;

          return pid !== undefined && !mayBeRunning(Number(pid));
        }),
      };
    },

    async warm(view, tool) {
      const template = templateOf(tool);

      // A tool sbx ships no template for has no warm template either: create fails it with bad_option.
      if (template === undefined) return { ok: true };
      const from = await warmFrom(template, view.worktree);

      if (!from.ok) return from;
      // create works the template out again; the open's display names the one made here.
      const [, tag] = from.args;

      return tag === undefined ? { ok: true } : { ok: true, warmed: { image: tag } };
    },

    async create(key, { view, tool }) {
      const template = templateOf(tool);

      if (template === undefined) {
        return { ok: false, failure: { code: 'bad_option', key: 'agent', message: `sbx ships no template for ${tool}, the tool of attempt ${key.attempt}. Set agent to a kit reference that brings ${tool}, or run the step on claude or codex` } };
      }

      const mounted = mountsOf('sbx', view);

      if (!mounted.ok) return mounted;
      const from = await warmFrom(template, view.worktree, { creating: true });

      if (!from.ok) return from;
      const name = nameOf(key);
      // mountsOf lists the worktree first, which sbx takes as the primary workspace.
      const paths = mounted.mounts.map(({ at, mode }) => (mode === 'ro' ? `${at}:ro` : at));
      const created = await cli(['create', '--name', name, '--no-progress', ...from.args, template, ...paths]);

      if (created.kind === 'ran' && created.code === 0) {
        // An open that names no tool is of the agent's, when the agent is a tool's own template.
        const linked = await linkSignIns(name, view.toolHome, tool ?? LAUNCHABLE.find((each) => each === agent));

        return linked.ok ? { ok: true, id: name } : linked;
      }

      // Another open of the same attempt created it first: that sandbox is this attempt's.
      const raced = await find(key);

      if (raced.ok && raced.id !== undefined) return { ok: true, id: name };

      return { ok: false, failure: { code: 'sandbox_failed', message: `sbx could not create the sandbox for attempt ${key.attempt} from agent ${template}: ${messageOf(created)}` } };
    },

    client(id, spec) {
      const { args, env: clientEnv } = execOf(id, { ...spec, argv: [] }, { isInteractive: true });

      return { ok: true, ...signalled({ exec: [executable, ...args], argv: spec.argv }), env: definedOnly(clientEnv) };
    },

    async exec(id, spec, onOutput): Promise<ExecEnd> {
      const { args, env: cliEnv } = execOf(id, spec, { isInteractive: false });
      let isFirstChunk = true;

      // A sandbox sbx stopped while idle starts again first, with sbx's own notice before the step's stderr.
      const ran = await cli(args, {
        env: cliEnv,
        onOutput: (stream, data) => {
          const own = isFirstChunk && stream === 'stderr' ? data.replace(STARTED, '') : data;
          isFirstChunk = false;

          if (own !== '') onOutput(stream, own);
        },
      });

      return ran.kind === 'ran' ? { kind: 'exited', code: ran.code } : { kind: 'failed', failure: { code: 'exec_failed', message: ran.message } };
    },

    async stop(id) {
      const stopped = await cli(['stop', id], { timeoutMs: COMMAND_MS });

      if (stopped.kind === 'ran' && stopped.code === 0) return { ok: true };

      return { ok: false, failure: { code: 'sandbox_failed', message: `sbx could not stop sandbox ${id}: ${messageOf(stopped)}. What runs there may still run; remove it with \`sbx rm --force ${id}\`.` } };
    },

    destroy: remove,

    name: nameOf,
    display: (key, warmed) => ({ label: `${nameOf(key)} (sbx)`, fields: { sandbox: nameOf(key), ...(agent !== undefined && { agent: path.basename(agent) }), ...(warmed && { template: warmed.image }) } }),

    removal: (place) => `remove it with \`sbx rm --force ${nameOf(place)}\``,
  };
}

/** Where the sbx provider of the journal state `state` records the warm templates it saved. */
function warmRecords(state: string): string {
  return path.join(state, 'warm');
}

/** Each warm template the sbx provider recorded in `state` as one it saved, as `sbx template <tag>`: asks sbx nothing. */
export function warmTemplatesSaved({ state }: { state: string }): string[] {
  return savedWarm(warmRecords(state)).tags().map((tag) => `sbx template ${tag}`);
}

/**
 * Removes each warm template the sbx provider recorded in `state` as one it saved, as `teamai uninstall` has the runtime
 * do in the member's HOME, whose templates sbx keeps; one already gone is forgotten. A kit template of the same image
 * id is named, never removed: it is sbx's, and other sandboxes start from it. Nothing recorded, it runs no sbx command.
 */
export async function removeWarmTemplates({ state, env }: { state: string; env: NodeJS.ProcessEnv }): Promise<WarmRemoval> {
  const records = savedWarm(warmRecords(state));
  const outcome: WarmRemoval = { removed: [], left: [] };
  const tags = records.tags();

  if (tags.length === 0) return outcome;
  const { run: cli } = cliOf({ name: PROVIDER_COMMANDS.sbx, env, notInstalled: 'sbx is not installed here, or not on PATH' });
  const listed = await cli(['template', 'ls', '--json'], { timeoutMs: COMMAND_MS, isListing: true });
  const warmListed = listed.kind === 'ran' && listed.code === 0 ? sbxWarmTemplatesListed(listed.stdout) : undefined;
  const kits = listed.kind === 'ran' && listed.code === 0 ? sbxKitTemplatesListed(listed.stdout) ?? [] : [];

  if (warmListed === undefined) {
    const said = listed.kind === 'ran' && listed.code === 0 ? 'it printed no list teamai reads' : messageOf(listed);

    return { removed: [], left: tags.map((tag) => `Could not look for sbx template ${tag}, a warm template teamai's sandbox saved (${said}). Once \`sbx template ls\` answers, remove it with \`sbx template rm --force ${tag}\`.`) };
  }

  for (const tag of tags) {
    const template = warmListed.find(({ key }) => `${WARM_REPOSITORY}:${key}` === tag);
    const ran = template === undefined ? undefined : await cli(['template', 'rm', '--force', template.ref], { timeoutMs: COMMAND_MS });

    if (template === undefined || ran === undefined) {
      records.forget(tag);
    } else if (ran.kind !== 'ran' || (ran.code !== 0 && !/image not found/i.test(ran.stderr))) {
      outcome.left.push(`Could not remove sbx template ${template.ref}, a warm template teamai's sandbox saved (${messageOf(ran)}). Remove it with \`sbx template rm --force ${template.ref}\`.`);
    } else {
      // sbx 0.53.0 answers a template already gone `image not found: … 404 Not Found`.
      records.forget(tag);

      if (ran.code !== 0) continue;
      outcome.removed.push(`Removed sbx template ${template.ref}, a warm template teamai's sandbox saved.`);

      for (const kit of kits.filter(({ id }) => id !== undefined && id === template.id)) {
        outcome.left.push(`sbx keeps the image of ${template.ref} as its template ${kit.ref} too, so removing it freed no disk. Remove that one with \`sbx template rm --force ${kit.ref}\` if no sandbox of yours starts from it.`);
      }
    }
  }

  return outcome;
}
