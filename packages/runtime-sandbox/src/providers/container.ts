import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readRegularFileSync, writeRegularFile } from '@teamai/shared/regular-file';
import type { ContainerEngine, ProfileOption, WarmOptions } from '../options.js';
import { PROVIDER_COMMANDS } from '../provider-commands.js';
import type { JournalId } from '../journal.js';
import type { Can, ConfinedOffer, RuntimeFailure } from '@teamai/runtime-protocol';
import { ANY_HOST, EVIDENCE_DIR, FILTER_PORT, FILTER_SCRIPT, judgeTool, thisMachineFileRule, thisMachineRule } from '../judge.js';
import { COMMAND_MS, handleOf, placeKeyOfHandle, type ExecEnd, type ExecSpec, type HostRoute, type PlaceKey, type Provider, type WarmedImage } from '../provider.js';
import { offerSignedIn } from '../sign-in.js';
import { isLeftBehind, oneBuildPerKey, planWarm, savedWarm, scratchOf, WARM_BY, warmFailed, type WarmPlan, type WarmRemoval } from '../warm.js';
import { cliOf, commandsOf, definedOnly, heldProbe, signalled, LAUNCHABLE, mountsOf, unmountable, WORKSPACES, type Ran } from './cli.js';

// ─── docker and podman ───────────────────────────────────
//
//  One long-lived container per attempt, idle until teamai execs in it:
//
//    docker run -d --name teamai-<run>-<attempt> --label teamai.run=<run> --label teamai.attempt=<attempt> --label teamai.owner=<journal>
//      --user <uid>:<gid>                      (podman: --userns keep-id)
//      --env HOME=/tmp/teamai-home              a private home, never the member's
//      -v <worktree>:<worktree>:rw -v <run dir>:<run dir>:rw -v <git path>:<git path>:ro …   every view path at its host path (,z on SELinux)
//      --entrypoint /bin/sh <image> -c <idle>
//    docker exec -w <cwd> -e NAME … <container> env -u WITHHELD … -- <argv>
//
//  With `warm`, each attempt's container starts from teamai-warm:<key> (warm.ts), made once per key from the image:
//
//    docker run -d --name teamai-warm-<key>-<random> --label teamai.warm-by=<host>:<pid> --env HOME=/tmp/teamai-home -v <scratch>:/teamai-warm:rw … <image>
//    docker exec -w /teamai-warm teamai-warm-<key>-<random> /bin/sh -c <prepare>        no credential, with the network
//    docker commit teamai-warm-<key>-<random> teamai-warm:<key>; docker rm --force …
//      or: docker build -t teamai-warm:<key> -f <checkout>/<containerfile> <scratch>
//
//  On docker, with node in the image, a step's container has no route out but a network filter (judge.ts), so it
//  reaches no port of this machine but the ones its credentials name, whatever it runs, as Paseo's daemon on loopback.
//  The filter knows this machine only on Docker Desktop (by the names it gives) and on Docker Engine on this Linux
//  machine (by its own addresses); a docker in a VM of its own (Colima, Rancher Desktop, Lima) reaches this machine at
//  an address of that VM's, so a step there is at `isolation: worktree`, as on podman:
//
//    docker network create --internal -o com.docker.network.bridge.inhibit_ipv4=true <name>-net
//    docker run -d --name <name>-proxy … --entrypoint node <image> -e <filter> 3128 '*' host.docker.internal:8317 '!<address>' …
//    docker network connect <name>-net <name>-proxy        the filter alone is on both networks
//    docker run -d --name <name> … --network <name>-net --env HTTPS_PROXY=http://<name>-proxy:3128 … (the step's, above)
//
//  A judge gets a container of its own the same way, its filter letting through only its model provider, and with no
//  capability: --cap-drop ALL --security-opt no-new-privileges, and `-v <dir>:/evidence:ro`. Podman, whose rootless
//  network cannot connect the filter, and an image without node keep a step on the engine's default network, which
//  reaches this machine (host.containers.internal, host.docker.internal): they offer `isolation: worktree` there.
//
//  Values never appear in an argv: `-e NAME` takes each from the engine CLI's own environment. Only the names an exec
//  is given cross into the container, so nothing else of teamai's environment does. The container's processes run one
//  exec at a time (teamai opens, execs, collects and closes each attempt in turn), so a stop restarts the container,
//  which ends every process in it and keeps the container for the next exec, while every path it mounts is still there.
//  Once one is gone, the stop removes the container instead, since a start would make that path again.
//

/** The private home of the step's processes inside the container. */
const CONTAINER_HOME = '/tmp/teamai-home';

/** PID 1 of every attempt container: idle, and gone at once on a stop. */
export const IDLE = `mkdir -p "$HOME"; trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done`;

/** The engine CLI's own settings: an exec's names never replace them, so a step cannot point the CLI at another daemon. */
const ENGINE_SETTINGS = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'CONTAINER_HOST', 'CONTAINER_CONNECTION', 'CONTAINERS_CONF'];

/** The filter always resolves host.docker.internal, to the address the engine reaches this machine by, so it refuses it. */
const HOST_GATEWAY = ['--add-host', 'host.docker.internal:host-gateway'];

/** What a judge's container and its filter run with: no capability, and no way to gain one. */
const LOCKED = ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'];

/** What ends the name of an attempt's network, and of its filter, after the handle of its place. */
const NETWORK_SUFFIX = '-net';
const FILTER_SUFFIX = '-proxy';

const networkOf = (key: PlaceKey): string => `${handleOf(key)}${NETWORK_SUFFIX}`;

const filterOf = (key: PlaceKey): string => `${handleOf(key)}${FILTER_SUFFIX}`;

/**
 * What a container or network name teamai gave is of its attempt: the place, the filter in front of a step or a judge,
 * or their network. Undefined for any other name.
 */
export function containerNamed(name: string): { kind: 'place' | 'filter' | 'network'; key: PlaceKey } | undefined {
  for (const [kind, suffix] of [['network', NETWORK_SUFFIX], ['filter', FILTER_SUFFIX]] as const) {
    const key = name.endsWith(suffix) ? placeKeyOfHandle(name.slice(0, -suffix.length)) : undefined;

    if (key !== undefined) return { kind, key };
  }

  const key = placeKeyOfHandle(name);

  return key === undefined ? undefined : { kind: 'place', key };
}

/** Where a sandbox behind the filter of `key` sends what it reaches out to: the filter, by its name on their network. */
const proxyOf = (key: PlaceKey): string => `http://${filterOf(key)}:${FILTER_PORT}`;

/** The addresses of this machine as this runtime sees them (its LAN address), which a filter's container cannot tell. */
function thisMachineAddresses(): string[] {
  return Object.values(os.networkInterfaces()).flatMap((found) => (found ?? []).flatMap((one) => (one.internal || one.address.startsWith('fe80') ? [] : [one.address])));
}

/** Where a step's filter reads the addresses of this machine, which the runtime keeps current, in a folder of its own. */
const THIS_MACHINE_DIR = '/teamai-this-machine';
const THIS_MACHINE_FILE = 'this-machine';

/**
 * Writes the addresses of this machine as they are now into each step filter's file under `filters` that lists others.
 * A rename, so a filter never reads half a list.
 */
function keepThisMachine(filters: string): void {
  const now = `${thisMachineAddresses().join('\n')}\n`;

  for (const name of fs.existsSync(filters) ? fs.readdirSync(filters) : []) {
    const file = path.join(filters, name, THIS_MACHINE_FILE);

    try {
      if (readRegularFileSync(file, 'utf8') === now) continue;
      const next = `${file}.${process.pid}`;

      fs.rmSync(next, { force: true });
      fs.writeFileSync(next, now, { flag: 'wx' });
      fs.renameSync(next, file);
    } catch {
      // A place closed meanwhile has no file left to keep.
    }
  }
}

const watched = new Set<string>();

/** Keeps the files under `filters` current while this runtime runs: an address this machine gains is refused within 2 s. */
function watchThisMachine(filters: string): void {
  if (watched.has(filters)) return;
  watched.add(filters);
  keepThisMachine(filters);
  setInterval(() => keepThisMachine(filters), 2000).unref();
}

/** Whether a step's container runs behind the network filter, and the name the engine gives this machine there. */
interface StepNetwork {
  isFiltered: boolean;
  alias: string | undefined;
}

/**
 * Whether a docker of `version` keeps DNS inside an internal network: before 26.0.0, 25.0.5 and 23.0.11 it forwarded a
 * container's lookups out of it (CVE-2024-29018), which a judge could use to send what it read.
 */
function dnsStaysInside(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.trim().split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);

  return major >= 26 || (major === 25 && (minor > 0 || patch >= 5)) || (major === 23 && (minor > 0 || patch >= 11));
}

/** Where a warm image's prepare runs, with the copies of the `cache` files mounted there. */
const WARM_DIR = '/teamai-warm';

/** The host path of each bind mount of a container, one per line. */
const BIND_SOURCES = '{{range .Mounts}}{{if eq .Type "bind"}}{{println .Source}}{{end}}{{end}}';

/** How often a removal another one is making is looked at until the container is gone. */
const REMOVAL_POLL_MS = 200;

/** Seconds a stop waits before the engine kills the container, well inside COMMAND_MS. */
const STOP_GRACE = '5';

export interface Host {
  /** The member's uid and gid, which the step's processes run as on docker; undefined where the OS has none. */
  user?: { uid: number; gid: number };
  /** Whether SELinux labels the host's files, so each mount needs the shared label. */
  selinux: boolean;
  /** The environment teamai started this runtime with, the engine CLI's own. */
  env: NodeJS.ProcessEnv;
}

/**
 * `owner`: the id of the journal whose attempts the containers are, which labels each one. `warm`: the recipe of the
 * warm image each attempt's container starts from, made on `image`; unset, it starts from `image`.
 */
export function containerProvider({ engine, image, owner, host, warm, profile, state }: { engine: ContainerEngine; image: string; owner: JournalId; host: Host; warm?: WarmOptions; profile?: ProfileOption; state: string }): Provider {
  const notInstalled = engine === 'docker'
    ? 'docker is not installed here, or not on PATH. Install Docker Desktop (https://docs.docker.com/get-docker/) or Docker Engine, start it, and start again.'
    : 'podman is not installed here, or not on PATH. Install Podman (https://podman.io/docs/installation), run `podman machine init && podman machine start` on macOS or Windows, and start again.';

  const { run: cli, why, executable } = cliOf({ name: PROVIDER_COMMANDS[engine], env: host.env, notInstalled });

  /** The engine CLI's environment for an exec: the spec's names over this runtime's own, the CLI's settings kept. */
  const execEnv = (spec: ExecSpec): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...host.env, ...spec.env };

    for (const setting of ENGINE_SETTINGS) env[setting] = host.env[setting];

    return env;
  };

  /** `exec`'s arguments: each of the spec's names by name only (`-e NAME`), the withheld ones unset in the container. */
  const execArgs = (id: string, spec: ExecSpec, { isInteractive }: { isInteractive: boolean }): string[] => {
    const withheld = spec.unset.length > 0 ? ['env', ...spec.unset.flatMap((variable) => ['-u', variable]), '--'] : [];

    return ['exec', ...(isInteractive ? ['-i'] : []), '-w', spec.cwd, ...Object.keys(spec.env).flatMap((variable) => ['-e', variable]), id, ...withheld, ...spec.argv];
  };

  const lastLine = (ran: Ran): string => (ran.kind === 'ran' ? ran.stderr.trim().split('\n').at(-1) ?? '' : '');

  const unavailable = (message: string) => ({ ok: false, failure: { code: 'sandbox_unavailable', message } }) satisfies { ok: false; failure: RuntimeFailure };

  const notRunning = (ran: Ran): string => (engine === 'docker'
    ? `docker is installed, but its daemon is not running (${lastLine(ran)}). Start Docker Desktop, or run \`sudo systemctl start docker\` on Linux, and start again.`
    : `podman cannot reach its service (${lastLine(ran)}). Run \`podman machine start\` on macOS or Windows, or check \`podman info\` on Linux, and start again.`);

  const user = (): string[] => (engine === 'podman' ? ['--userns', 'keep-id'] : host.user ? ['--user', `${host.user.uid}:${host.user.gid}`] : []);

  /** Whether the engine said the thing to create exists already, or the thing to remove does not. */
  const said = (ran: Ran, pattern: RegExp): boolean => ran.kind === 'ran' && pattern.test(ran.stderr);

  const sandboxFailed = (message: string) => ({ ok: false as const, failure: { code: 'sandbox_failed', message } });

  const once = oneBuildPerKey<{ ok: true } | { ok: false; failure: RuntimeFailure }>();

  /**
   * What `offer` found, which each step's container is created on: whether steps run behind the network filter, and the
   * name the engine gives this machine, at which a credential on this machine is let through.
   */
  let steps: StepNetwork = { isFiltered: false, alias: undefined };

  const filters = path.join(state, 'filters');

  // Also for a provider a place opened earlier is reached through, whose offer never ran: its filter reads them too.
  if (engine === 'docker') watchThisMachine(filters);
  /** The folder a step filter of `key` reads the addresses of this machine from. */
  const thisMachineOf = (key: PlaceKey): string => path.join(filters, handleOf(key));

  /** Removes the filter of `key` and its network, ok when it has none. */
  const release = async (key: PlaceKey): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }> => {
    const filter = await cli(['rm', '--force', filterOf(key)], { timeoutMs: COMMAND_MS });

    if (!(filter.kind === 'ran' && (filter.code === 0 || said(filter, /no such container/i)))) {
      return { ok: false, failure: { code: 'sandbox_failed', message: `${engine} could not remove the network filter ${filterOf(key)}: ${why(filter)}. Remove it with \`${engine} rm --force ${filterOf(key)}\`.` } };
    }

    const network = await cli(['network', 'rm', networkOf(key)], { timeoutMs: COMMAND_MS });

    if (!(network.kind === 'ran' && (network.code === 0 || said(network, /not found|no such network/i)))) {
      return { ok: false, failure: { code: 'sandbox_failed', message: `${engine} could not remove the network ${networkOf(key)}: ${why(network)}. Remove it with \`${engine} network rm ${networkOf(key)}\`.` } };
    }

    fs.rmSync(thisMachineOf(key), { recursive: true, force: true });

    return { ok: true };
  };

  /**
   * Makes the internal network of `key` and the filter in front of it, which lets through what `rules` name (judge.ts),
   * and is labelled by the run only, so the attempt's labels find its sandbox alone; a sweep reads its attempt from
   * teamai.filter. What it made stays for `release` when a later step fails; a network it made itself, it removes when
   * it fails, rather than leave it to a later open's sweep.
   */
  const filtered = async (key: PlaceKey, rules: string[], { isStep }: { isStep: boolean }): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }> => {
    // No address of the host on the bridge either, so the host's own services are out of reach too; and no IPv6, which
    // a daemon's default-network-opts may turn on, so the bridge holds no IPv6 address of the host.
    const network = await cli(['network', 'create', '--internal', '-o', 'com.docker.network.bridge.inhibit_ipv4=true', '-o', 'com.docker.network.enable_ipv6=false', '--label', `teamai.run=${key.run}`, '--label', `teamai.attempt=${key.attempt}`, '--label', `teamai.owner=${owner}`, networkOf(key)]);

    if (!(network.kind === 'ran' && (network.code === 0 || said(network, /already exists/i)))) return sandboxFailed(`${engine} could not create the network ${networkOf(key)} of attempt ${key.attempt}: ${why(network)}`);
    const own = isStep ? ['-v', `${thisMachineOf(key)}:${THIS_MACHINE_DIR}:ro${host.selinux ? ',z' : ''}`] : [];

    if (isStep) {
      fs.mkdirSync(thisMachineOf(key), { recursive: true });
      await writeRegularFile(path.join(thisMachineOf(key), THIS_MACHINE_FILE), '');
      keepThisMachine(filters);
    }

    const filter = await cli(['run', '-d', '--name', filterOf(key), '--label', `teamai.run=${key.run}`, '--label', `teamai.filter=${key.attempt}`, '--label', `teamai.owner=${owner}`, ...user(), ...LOCKED, ...own, ...HOST_GATEWAY, '--entrypoint', 'node', image, '-e', FILTER_SCRIPT, String(FILTER_PORT), ...rules, ...(isStep ? [thisMachineFileRule(`${THIS_MACHINE_DIR}/${THIS_MACHINE_FILE}`)] : [])]);

    const joined = filter.kind === 'ran' && (filter.code === 0 || said(filter, /already in use/i)) ? await cli(['network', 'connect', networkOf(key), filterOf(key)]) : undefined;

    if (joined?.kind === 'ran' && (joined.code === 0 || said(joined, /already exists|already attached/i))) return { ok: true };

    const failed = joined === undefined
      ? sandboxFailed(`${engine} could not start the network filter ${filterOf(key)}: ${why(filter)}`)
      : sandboxFailed(`${engine} could not connect the network filter to ${networkOf(key)}: ${why(joined)}`);

    // A network an earlier open made is that open's place's, which a failed open again keeps.
    if (network.code !== 0) return failed;

    const released = await release(key);

    return released.ok ? failed : { ok: false, failure: { ...failed.failure, message: `${failed.failure.message} ${released.failure.message}` } };
  };

  /** Makes the warm image of `plan` from `image` with its `cache` files, in a scratch container or build. */
  const records = savedWarm(warmRecords(state));

  const makeWarm = async (plan: WarmPlan): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }> => {
    const scratch = scratchOf(plan.cache);

    try {
      const { make } = plan;

      if ('containerfile' in make) {
        const built = await cli(['build', '-t', plan.tag, '-f', make.containerfile, scratch.dir]);

        return built.kind === 'ran' && built.code === 0 ? { ok: true } : warmFailed(`${engine} could not build the warm image ${plan.tag} from ${make.containerfile}`, built);
      }

      const name = `teamai-warm-${plan.key}-${crypto.randomBytes(3).toString('hex')}`;

      const created = await cli([
        'run', '-d', '--name', name, '--label', `teamai.owner=${owner}`, '--label', `teamai.warm-by=${WARM_BY}`, ...user(), '--env', `HOME=${CONTAINER_HOME}`,
        '-v', `${scratch.dir}:${WARM_DIR}:rw${host.selinux ? ',z' : ''}`, '--entrypoint', '/bin/sh', image, '-c', IDLE,
      ]);

      if (!(created.kind === 'ran' && created.code === 0)) return warmFailed(`${engine} could not start a container from ${image} to prepare the warm image ${plan.tag}`, created);

      try {
        const prepared = await cli(['exec', '-w', WARM_DIR, name, '/bin/sh', '-c', make.prepare]);

        if (!(prepared.kind === 'ran' && prepared.code === 0)) return warmFailed(`The warm image's prepare, \`${make.prepare}\`, failed in a container from ${image}`, prepared);
        const committed = await cli(['commit', name, plan.tag]);

        return committed.kind === 'ran' && committed.code === 0 ? { ok: true } : warmFailed(`${engine} could not save the warm image ${plan.tag}`, committed);
      } finally {
        await cli(['rm', '--force', name], { timeoutMs: COMMAND_MS });
      }
    } finally {
      scratch.remove();
    }
  };

  /** The image an attempt in `checkout` starts from: the warm image, made first when it is not there yet, else `image`. */
  /**
   * What a warm image is keyed by: `image` with the id it has here, pulled first when it is not, so the tag pushed again
   * and pulled makes a new warm image. An image the engine cannot give is keyed by its name: its build then fails.
   */
  const baseOf = async (): Promise<string> => {
    const inspect = () => cli(['image', 'inspect', '--format', '{{.Id}}', image], { timeoutMs: COMMAND_MS });
    let found = await inspect();

    if (!(found.kind === 'ran' && found.code === 0)) {
      await cli(['pull', image]);
      found = await inspect();
    }

    return found.kind === 'ran' && found.code === 0 ? `${image}@${found.stdout.trim()}` : image;
  };

  const isPresent = async (tag: string): Promise<boolean> => {
    const present = await cli(['image', 'inspect', '--format', '{{.Id}}', tag]);

    return present.kind === 'ran' && present.code === 0;
  };

  /** The image an attempt in `checkout` starts from: the warm image, made first when it is not there yet, else `image`. */
  const warmImageFor = async (checkout: string): Promise<{ ok: true; image: string } | { ok: false; failure: RuntimeFailure }> => {
    if (warm === undefined) return { ok: true, image };
    const planned = planWarm({ base: await baseOf(), recipe: warm, checkout, ...(profile && { profile }) });

    if (!planned.ok) return planned;
    const { plan } = planned;

    const made = await once(plan.key, async () => {
      if (await isPresent(plan.tag)) return { ok: true };
      const built = await makeWarm(plan);

      if (built.ok) records.record(plan.tag);

      return built;
    });

    return made.ok ? { ok: true, image: plan.tag } : made;
  };

  /**
   * The image attempt `attempt`'s sandbox starts from: the warm image `warm` made for its open, still there, not the key
   * worked out again, which a base pulled again meanwhile would move; else `image`. Its creation, which a close waits
   * for, neither builds nor pulls.
   */
  const createdFrom = async (warmed: WarmedImage | undefined, attempt: string): Promise<{ ok: true; image: string } | { ok: false; failure: RuntimeFailure }> => {
    if (warm === undefined) return { ok: true, image };
    const tag = warmed?.image;

    if (tag === undefined) return sandboxFailed(`No warm image was made for attempt ${attempt} in this runtime, so no sandbox was made for it. Start the step again.`);

    return await isPresent(tag) ? { ok: true, image: tag } : sandboxFailed(`The warm image ${tag} was removed after it was made for attempt ${attempt}, so no sandbox was made for it. Start the step again, and teamai makes the image again.`);
  };

  const destroy: Provider['destroy'] = async (id) => {
    const deadline = Date.now() + COMMAND_MS;
    const removed = await cli(['rm', '--force', id], { timeoutMs: COMMAND_MS });

    if (removed.kind === 'ran' && (removed.code === 0 || /no such container/i.test(removed.stderr))) return { ok: true };

    // Another removal of it, such as a stop's while this is a close's, goes on in the engine: ok once it is gone.
    while (removed.kind === 'ran' && /already in progress/i.test(removed.stderr) && Date.now() < deadline) {
      await sleep(REMOVAL_POLL_MS);
      const left = await cli(['inspect', '--type', 'container', '--format', BIND_SOURCES, id], { timeoutMs: Math.max(1, deadline - Date.now()) });

      if (left.kind === 'ran' && left.code !== 0 && /no such container/i.test(left.stderr)) return { ok: true };
    }

    return { ok: false, failure: { code: 'sandbox_failed', message: `${engine} could not remove container ${id}: ${why(removed)}. Remove it with \`${engine} rm --force ${id}\`.` } };
  };

  const find: Provider['find'] = async (key) => {
    const listed = await cli(['ps', '-a', '-q', '--filter', `label=teamai.run=${key.run}`, '--filter', `label=teamai.attempt=${key.attempt}`], { timeoutMs: COMMAND_MS, isListing: true });

    if (listed.kind === 'ran' && listed.code === 0) return { ok: true, id: listed.stdout.trim().split('\n').find((line) => line !== '') };

    return sandboxFailed(`${engine} could not look for the container of attempt ${key.attempt}: ${why(listed)}. Its container, if it has one, stays this attempt's until ${engine} answers again; to remove it now, run \`${engine} rm --force ${handleOf(key)}\`.`);
  };

  /** What the engine says of itself, its version and system, or why it does not answer. */
  const engineInfo = async () => {
    const info = await cli(['info', '--format', engine === 'podman' ? '{{.Version.Version}}' : '{{.ServerVersion}}|{{.OperatingSystem}}|{{.Name}}']);

    if (info.kind !== 'ran') return unavailable(info.message);

    return info.code === 0 ? { ok: true as const, info: info.stdout } : unavailable(notRunning(info));
  };

  return {
    family: 'bind',
    async reachable() {
      const reached = await engineInfo();

      return reached.ok ? { ok: true } : reached;
    },
    async offer(credentials, instances) {
      const reached = await engineInfo();

      if (!reached.ok) return reached;
      const [version = '', system = '', daemonHost = ''] = reached.info.trim().split('|');

      // Docker Desktop names this machine host.docker.internal in every container, and Podman host.containers.internal;
      // Docker Engine on Linux names it nothing.
      const route: HostRoute = engine === 'podman' || system === 'Docker Desktop'
        ? { ok: true, alias: engine === 'podman' ? 'host.containers.internal' : 'host.docker.internal' }
        : { ok: false, refusal: `docker reports its system as "${system}", not Docker Desktop, and teamai knows the name a container has for this machine only on Docker Desktop (host.docker.internal); Docker Engine on Linux gives it none.` };

      const present = await cli(['image', 'inspect', '--format', '{{.Id}}', image]);

      if (present.kind !== 'ran' || present.code !== 0) {
        const pulled = await cli(['pull', image]);

        if (pulled.kind !== 'ran' || pulled.code !== 0) {
          return unavailable(`${engine} could not pull image ${image} (${lastLine(pulled)}). Check its name, and that you are logged in to its registry (\`${engine} login <registry>\`), and start again.`);
        }
      }

      const probe = await cli(['run', '--rm', '--entrypoint', '/bin/sh', image, ...heldProbe([...LAUNCHABLE, 'node', ...commandsOf(instances)])]);

      if (probe.kind !== 'ran' || probe.code !== 0) return unavailable(`${engine} could not start a container from ${image} (${lastLine(probe)}). Check that it runs /bin/sh, and start again.`);
      const found = new Set(probe.stdout.split('\n').map((line) => line.trim()));

      // A login on this machine never crosses into a container: a tool is offered only on a credential teamai gives it.
      const { tools: offered, unavailable: notSignedIn } = offerSignedIn({
        tools: LAUNCHABLE.filter((tool) => found.has(tool)), provider: engine, credentials, stored: new Set(), instances,
        missing: (command) => (found.has(command) ? undefined : { holder: `image ${image}`, fix: 'add it to the image' }),
      });

      // A judge runs a tool teamai ships, never an instance.
      const shipped = offered.filter((tool) => LAUNCHABLE.some((launchable) => launchable === tool));
      // A judge's network filter runs on the image's node, so an image without it judges nothing, nor a docker that lets
      // DNS out of the judge's network. Podman judges nothing: its rootless network cannot connect the filter to it.
      const confined: ConfinedOffer[] = [];

      const canFilter = found.has('node') && engine === 'docker' && dnsStaysInside(version);
      // A step's network filter, the same, keeps it from this machine where it knows how the engine reaches it: without
      // it, the step reaches every port here. A judge's lets through only its model provider, so it needs no such knowledge.
      const knowsThisMachine = system === 'Docker Desktop' || (process.platform === 'linux' && daemonHost === os.hostname());
      steps = { isFiltered: canFilter && knowsThisMachine, alias: route.ok ? route.alias : undefined };

      const judges = canFilter ? shipped : [];

      for (const tool of judges) {
        const access = judgeTool(tool)?.access;

        if (access === undefined) continue;
        const offer = confined.find((existing) => existing.access === access);

        if (offer) offer.tools.push(tool);
        else confined.push({ level: 'verified', access, tools: [tool] });
      }

      const can: Can = {
        workspace: WORKSPACES, isolation: steps.isFiltered ? 'sandbox' : 'worktree', env: true, tokens: true, max_turns: true, setup: true, tools: offered, end_turn: true, ...(steps.isFiltered && { unattended: true }), role: true,
        ...(confined.length > 0 && { confined }),
      };

      // A container keeps no login of its own: every sign-in comes from teamai.
      return { ok: true, can, host: route, unavailable: notSignedIn, ownLogins: [], unusedGateways: {} };
    },

    find,

    async owned() {
      const listed = await cli(['ps', '-a', '--filter', `label=teamai.owner=${owner}`, '--format', '{{.ID}} {{.Label "teamai.run"}} {{.Label "teamai.attempt"}}{{.Label "teamai.filter"}}{{.Label "teamai.judge"}} {{.Label "teamai.warm-by"}}'], { timeoutMs: COMMAND_MS, isListing: true });

      if (!(listed.kind === 'ran' && listed.code === 0)) return sandboxFailed(`${engine} could not list the containers this runtime's journal owns: ${why(listed)}`);
      const lines = listed.stdout.split('\n').map((line) => line.trim().split(' '));
      const networks = await cli(['network', 'ls', '--filter', `label=teamai.owner=${owner}`, '--format', '{{.Name}}'], { timeoutMs: COMMAND_MS, isListing: true });

      if (!(networks.kind === 'ran' && networks.code === 0)) return sandboxFailed(`${engine} could not list the networks this runtime's journal owns: ${why(networks)}`);

      return {
        ok: true,
        sandboxes: lines.flatMap(([id, run, attempt]) => (id && run && attempt ? [{ id, run, attempt }] : [])),
        leftWarm: lines.flatMap(([id, run, attempt, by]) => (id && !run && !attempt && by && isLeftBehind(by) ? [id] : [])),
        released: networks.stdout.split('\n').flatMap((name) => {
          const named = containerNamed(name.trim());

          return named?.kind === 'network' ? [named.key] : [];
        }),
      };
    },

    async warm(view) {
      const from = await warmImageFor(view.worktree);

      return from.ok ? { ok: true, warmed: { image: from.image } } : from;
    },

    async create(key, { view, warmed, hostPorts }) {
      const mounted = mountsOf(engine, view);

      if (!mounted.ok) return mounted;
      const from = await createdFrom(warmed, key.attempt);

      if (!from.ok) return from;
      const label = host.selinux ? ',z' : '';
      const volumes = mounted.mounts.flatMap(({ at, mode }) => ['-v', `${at}:${at}:${mode}${label}`]);
      let network: string[] = [];

      if (steps.isFiltered) {
        const { alias } = steps;
        const made = await filtered(key, [ANY_HOST, ...(alias === undefined ? [] : hostPorts.map((port) => `${alias}:${port}`)), ...thisMachineAddresses().map(thisMachineRule)], { isStep: true });

        if (!made.ok) return made;
        const proxy = proxyOf(key);
        // Every client that takes a proxy from its environment, in either spelling; the step's own loopback stays its own.
        network = ['--network', networkOf(key), ...['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'].flatMap((name) => ['--env', `${name}=${proxy}`]), '--env', 'NO_PROXY=localhost,127.0.0.1,::1', '--env', 'no_proxy=localhost,127.0.0.1,::1'];
      }

      const created = await cli([
        'run', '-d', '--name', handleOf(key), '--label', `teamai.run=${key.run}`, '--label', `teamai.attempt=${key.attempt}`, '--label', `teamai.owner=${owner}`, ...user(), ...network,
        '--env', `HOME=${CONTAINER_HOME}`, ...volumes, '--entrypoint', '/bin/sh', from.image, '-c', IDLE,
      ]);

      if (created.kind === 'ran' && created.code === 0) return { ok: true, id: created.stdout.trim() };
      // Another open of the same attempt created it first: that container is this attempt's.
      const existing = await find(key);

      if (existing.ok && existing.id !== undefined) return { ok: true, id: existing.id };

      return { ok: false, failure: { code: 'sandbox_failed', message: created.kind !== 'ran' ? created.message : `${engine} could not create the container for attempt ${key.attempt} from ${from.image}: ${lastLine(created)}` } };
    },

    judges: {
    async create(key, { dir, hosts }) {
      const existing = await find(key);

      if (!existing.ok) return existing;

      if (existing.id !== undefined) return { ok: true, id: existing.id };
      const refused = unmountable(engine, dir);

      if (refused) return { ok: false, failure: refused };

      const labels = ['--label', `teamai.run=${key.run}`, '--label', `teamai.attempt=${key.attempt}`, '--label', `teamai.owner=${owner}`];
      const made = await filtered(key, hosts, { isStep: false });

      if (!made.ok) return made;
      const proxy = proxyOf(key);

      const created = await cli([
        'run', '-d', '--name', handleOf(key), ...labels, ...user(), '--network', networkOf(key), ...LOCKED,
        '--env', `HOME=${CONTAINER_HOME}`, '--env', `HTTPS_PROXY=${proxy}`, '--env', `HTTP_PROXY=${proxy}`, '--env', 'NO_PROXY=',
        '-v', `${dir}:${EVIDENCE_DIR}:ro${host.selinux ? ',z' : ''}`, '--entrypoint', '/bin/sh', image, '-c', IDLE,
      ]);

      if (created.kind === 'ran' && created.code === 0) return { ok: true, id: created.stdout.trim() };
      const raced = await find(key);

      return raced.ok && raced.id !== undefined ? { ok: true, id: raced.id } : sandboxFailed(`${engine} could not create the judge container for attempt ${key.attempt} from ${image}: ${why(created)}`);
    },
    },

    release,

    client(id, spec) {
      // A sandbox an app's tool runs in reaches nothing of this machine: one not behind the filter runs none.
      if (!steps.isFiltered) {
        return { ok: false, failure: { code: 'isolation_unproven', message: `teamai keeps a container from this machine only behind its network filter, which runs on Docker Desktop or on Docker Engine on this Linux machine, 26.0.0 or later (25.0.5, 23.0.11), not podman or a docker in a VM of its own, with node in the image, so it runs no app's tool in this one (${engine}, image ${image}). Use such a docker with node in the image, or provider: sbx.` } };
      }

      return { ok: true, ...signalled({ exec: [executable, ...execArgs(id, { ...spec, argv: [] }, { isInteractive: true })], argv: spec.argv }), env: definedOnly(execEnv(spec)) };
    },

    async exec(id, spec, onOutput): Promise<ExecEnd> {
      const ran = await cli(execArgs(id, spec, { isInteractive: false }), { env: execEnv(spec), onOutput });

      return ran.kind === 'ran' ? { kind: 'exited', code: ran.code } : { kind: 'failed', failure: { code: 'exec_failed', message: ran.message } };
    },

    async stop(id) {
      const unstopped = (ran: Ran) => ({ ok: false, failure: { code: 'sandbox_failed', message: `${engine} could not stop the processes in container ${id}: ${why(ran)}. They may still run; remove the container with \`${engine} rm --force ${id}\`.` } }) satisfies { ok: false; failure: RuntimeFailure };
      // A start makes each bind source that is gone again, as an empty directory (Docker Desktop 29), or fails: a
      // container whose place went is removed instead. A restart is one engine call, so the step's next exec never
      // finds the container stopped.
      const listed = await cli(['inspect', '--type', 'container', '--format', BIND_SOURCES, id], { timeoutMs: COMMAND_MS });

      if (listed.kind !== 'ran' || listed.code !== 0) return unstopped(listed);

      if (listed.stdout.split('\n').some((source) => source !== '' && !fs.existsSync(source))) return destroy(id);
      const restarted = await cli(['restart', '--time', STOP_GRACE, id], { timeoutMs: COMMAND_MS });

      return restarted.kind === 'ran' && restarted.code === 0 ? { ok: true } : unstopped(restarted);
    },

    destroy,

    name: handleOf,
    display: (key, warmed) => {
      const ran = warm === undefined ? image : warmed?.image;

      return { label: `${handleOf(key)} (${engine})`, fields: { container: handleOf(key), ...(ran !== undefined && { image: ran }), ...(warm !== undefined && { base: image }) } };
    },

    // A sandbox behind the filter has its filter and network too; a recover init, which offers nothing, cannot tell.
    removal: (place) => (place.confined || steps.isFiltered
      ? `remove it with \`${engine} rm --force ${handleOf(place)} ${filterOf(place)}\` and \`${engine} network rm ${networkOf(place)}\``
      : `remove it with \`${engine} rm --force ${handleOf(place)}\`, and its network filter, if it has one, with \`${engine} rm --force ${filterOf(place)}\` and \`${engine} network rm ${networkOf(place)}\``),
  };
}

/** Where the container provider of the journal state `state` records the warm images it saved. */
function warmRecords(state: string): string {
  return path.join(state, 'warm');
}

/** Each warm image `engine`'s provider recorded in `state` as one it saved, as `engine image <tag>`: asks the engine nothing. */
export function warmImagesSaved({ engine, state }: { engine: ContainerEngine; state: string }): string[] {
  return savedWarm(warmRecords(state)).tags().map((tag) => `${engine} image ${tag}`);
}

/**
 * Removes each warm image `engine`'s provider recorded in `state` as one it saved, as `teamai uninstall` has the runtime
 * do in the member's HOME; one already gone is forgotten. Nothing recorded, it runs no engine command.
 */
export async function removeWarmImages({ engine, state, env }: { engine: ContainerEngine; state: string; env: NodeJS.ProcessEnv }): Promise<WarmRemoval> {
  const records = savedWarm(warmRecords(state));
  const outcome: WarmRemoval = { removed: [], left: [] };
  const tags = records.tags();

  if (tags.length === 0) return outcome;
  const { run: cli, why } = cliOf({ name: PROVIDER_COMMANDS[engine], env, notInstalled: `${engine} is not installed here, or not on PATH` });

  for (const tag of tags) {
    const ran = await cli(['image', 'rm', tag], { timeoutMs: COMMAND_MS });
    // podman says `image not known`.
    const isGone = ran.kind === 'ran' && (ran.code === 0 || /no such image|image not known/i.test(ran.stderr));

    if (isGone) records.forget(tag);

    if (isGone && ran.code === 0) outcome.removed.push(`Removed ${engine} image ${tag}, a warm image teamai's sandbox made.`);
    else if (!isGone) outcome.left.push(`Could not remove ${engine} image ${tag}, a warm image teamai's sandbox made (${why(ran)}). Remove it with \`${engine} image rm ${tag}\` once ${engine} runs and no container uses it.`);
  }

  return outcome;
}
