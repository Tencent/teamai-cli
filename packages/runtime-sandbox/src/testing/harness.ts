import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeMessageSchema } from '@teamai/runtime-protocol';
import { bundleRuntime as bundleRuntimeAt } from '@teamai/runtime-testing/bundle';
import { connectRuntime, type Connection as RuntimeConnection, type Line } from '@teamai/runtime-testing/connect';
import type { BuildOptions, Plugin } from 'esbuild';
import { z } from 'zod';
import { entriesUnder } from '@teamai/shared/entries-under';

// ─── Test support: the runtime over its stdio, on a fake container engine ───
//
//  `bundleRuntime` builds the executable as the package ships it. `fakeEngine` lays out a `docker`, a `podman` and an
//  `sbx` on a PATH of their own, backed by fake-engine.mjs, with images (and sbx agents) whose tools are scripts in a
//  directory. `connect` starts
//  the runtime as teamai does and speaks protocol 1 to it as JSON lines (`@teamai/runtime-testing`).
//

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ENGINE = path.join(HERE, 'fake-engine.mjs');
const ENTRY = path.join(HERE, '..', 'main.ts');

/** Swaps `this-machine.ts` for `testing/this-machine.ts`, so a test may run stand-ins for macOS's own tools, or name the OS. */
export const THIS_MACHINE_STAND_IN: Plugin = {
  name: 'this-machine-stand-in',
  setup(bundler) {
    bundler.onResolve({ filter: /\/this-machine\.js$/ }, () => ({ path: path.join(HERE, 'this-machine.ts') }));
  },
};

/** Builds the runtime's executable into `outfile`, with what a test swaps in (`@teamai/runtime-testing/bundle`). */
export function bundleRuntimeWith({ outfile, alias, plugins }: { outfile: string } & Pick<BuildOptions, 'alias' | 'plugins'>): Promise<string> {
  return bundleRuntimeAt({ entry: ENTRY, outfile, ...(alias && { alias }), ...(plugins && { plugins }) });
}

/** Builds the runtime's executable into `dir`, as tsup bundles it, and returns its path. */
export function bundleRuntime(dir: string): Promise<string> {
  return bundleRuntimeWith({ outfile: path.join(dir, 'teamai-runtime-sandbox.mjs'), plugins: [THIS_MACHINE_STAND_IN] });
}

export interface FakeEngine {
  /** The directory `docker`, `podman` and `sbx` are in. */
  bin: string;
  state: string;
  log: string;
  /** The image (or sbx agent) `name`, holding `tools` as scripts that run `body` in node. */
  image(name: string, tools: Record<string, string>): void;
  /** Stops or starts the fake daemon. */
  daemon(up: boolean): void;
  /** Makes `rm` fail, as a daemon that cannot remove a container, or work again. */
  failRemove(shouldFail: boolean): void;
  /** Makes `run` of a network filter fail, as a daemon that cannot start one. */
  failFilter(shouldFail: boolean): void;
  /** Undoes every fault and delay a test set, as a member mends their engine, so what the test left can be closed. */
  repair(): void;
  /** Makes an exec whose process a stop or remove killed end `ms` after the command that killed it returned. */
  stopLag(ms: number): void;
  /** Makes a stop wait `ms` before it stops anything, as a daemon slow to answer. */
  stopDelay(ms: number): void;
  /** Makes a stop wait `ms` once it stopped the processes, before it answers, as an engine that restarts the container. */
  stopHold(ms: number): void;
  /** Makes docker's `rm` take `ms` once it stopped the processes, before the container is gone, as Docker Desktop's does. */
  holdRemove(ms: number): void;
  /** Makes each save of an image (`commit`, `build`, sbx `template save`) take `ms` while it writes the image. */
  holdSave(ms: number): void;
  /** Makes every later run of `command` (`run`, `rm`, …) wait `ms` before it does anything; 0 lets it run at once again. */
  delay(command: string, ms: number): void;
  /** Makes `version` print `version`, as the engine upgraded to it. */
  upgrade(version: string): void;
  /** Makes `ps --format` fail, as an engine that cannot render the format, or work again. */
  failFormat(shouldFail: boolean): void;
  /** Makes every later `run -d` wait `ms` once its container exists, before it answers; 0 answers at once again. */
  holdCreate(ms: number): void;
  /**
   * Makes every later `exec` wait `ms` before it starts its process: docker's or podman's once it found its container,
   * sbx's before it looks its sandbox up; 0 starts at once again.
   */
  holdExec(ms: number): void;
  /** Holds every later list of one journal's containers (`ps --filter label=teamai.owner=…`) until released. */
  holdOwned(isHeld: boolean): void;
  /** Whether a held list of one journal's containers is waiting now. */
  isListingOwned(): boolean;
  /** How many lists of one journal's containers it answered, as a sweep makes once per open. */
  ownedListings(): number;
  /** Stores or removes an sbx secret for `service`, which sbx's proxy injects; a sandbox sees only its placeholder. */
  secret(service: string, isSet: boolean): void;
  /** Makes sbx answer as one whose global network policy was initialized, or never was. */
  policy(isInitialized: boolean): void;
  /** Adds an allow rule for `target` (`localhost:<port>`) to sbx's network policy, as `sbx policy allow network` would. */
  allowNetwork(target: string): void;
  /** Every argv the engine was run with, as `[engine, ...args]`. */
  calls(): string[][];
  /** The containers (and sbx sandboxes) that exist, by name. */
  containers(): string[];
  /** The labels of the container named `name`, or undefined when there is none. */
  labelsOf(name: string): Record<string, string> | undefined;
  /** The networks that exist, by name. */
  networks(): string[];
  /** The tags of the images (sbx: templates) a `commit`, `build` or `template save` made. */
  savedImages(): string[];
  /** Every file a saved image holds in its home, and, for a built one, in its build context, each with its content. */
  savedFiles(tag: string): { home: Record<string, string>; context: Record<string, string> };
  env(): NodeJS.ProcessEnv;
}

/** Every file under `root`, by its path relative to it, with its content; none when it does not exist. */
function filesUnder(root: string): Record<string, string> {
  if (!fs.existsSync(root)) return {};

  return Object.fromEntries(entriesUnder(root).map(({ relative }) => relative).filter((file) => fs.lstatSync(path.join(root, file)).isFile()).map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
}

const StoredSchema = z.object({ name: z.string(), labels: z.record(z.string(), z.string()) });

export function fakeEngine(dir: string): FakeEngine {
  const bin = path.join(dir, 'engine-bin');
  const state = path.join(dir, 'engine-state');
  const log = path.join(dir, 'engine.log');
  const images: Record<string, string> = {};
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(state, { recursive: true });

  /** Every container (and sbx sandbox) the fake engine holds, with its name and labels. */
  const stored = (): Array<z.infer<typeof StoredSchema>> => {
    const root = path.join(state, 'containers');

    return (fs.existsSync(root) ? fs.readdirSync(root) : []).flatMap((id) => {
      const file = path.join(root, id, 'container.json');

      return fs.existsSync(file) ? [StoredSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')))] : [];
    });
  };

  for (const engine of ['docker', 'podman', 'sbx']) {
    fs.writeFileSync(path.join(bin, engine), `#!/bin/sh\nFAKE_ENGINE_NAME=${engine} exec "${process.execPath}" "${FAKE_ENGINE}" "$@"\n`, { mode: 0o755 });
  }

  return {
    bin, state, log,
    image(name, tools) {
      const at = path.join(dir, 'images', encodeURIComponent(name));
      fs.mkdirSync(at, { recursive: true });

      for (const [tool, body] of Object.entries(tools)) fs.writeFileSync(path.join(at, tool), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
      images[name] = at;
    },
    daemon(up) {
      if (up) fs.rmSync(path.join(state, 'down'), { force: true });
      else fs.writeFileSync(path.join(state, 'down'), '');
    },
    stopLag(ms) {
      fs.writeFileSync(path.join(state, 'stop-lag'), String(ms));
    },
    stopDelay(ms) {
      fs.writeFileSync(path.join(state, 'stop-delay'), String(ms));
    },
    stopHold(ms) {
      fs.writeFileSync(path.join(state, 'stop-hold'), String(ms));
    },
    holdRemove(ms) {
      fs.writeFileSync(path.join(state, 'rm-hold'), String(ms));
    },
    holdSave(ms) {
      fs.writeFileSync(path.join(state, 'save-hold'), String(ms));
    },
    upgrade(version) {
      fs.writeFileSync(path.join(state, 'version'), version);
    },
    delay(command, ms) {
      fs.writeFileSync(path.join(state, `delay-${command}`), String(ms));
    },
    failFormat(shouldFail) {
      if (shouldFail) fs.writeFileSync(path.join(state, 'format-fails'), '');
      else fs.rmSync(path.join(state, 'format-fails'), { force: true });
    },
    holdCreate(ms) {
      fs.writeFileSync(path.join(state, 'create-hold'), String(ms));
    },
    holdExec(ms) {
      fs.writeFileSync(path.join(state, 'exec-hold'), String(ms));
    },
    holdOwned(isHeld) {
      if (isHeld) fs.writeFileSync(path.join(state, 'owned-hold'), '');
      else fs.rmSync(path.join(state, 'owned-hold'), { force: true });
    },
    isListingOwned: () => fs.existsSync(path.join(state, 'owned-listing')),
    ownedListings: () => (fs.existsSync(path.join(state, 'owned-listed')) ? fs.readFileSync(path.join(state, 'owned-listed'), 'utf8').length : 0),
    repair() {
      for (const name of fs.readdirSync(state)) {
        if (['down', 'stop-lag', 'stop-delay', 'stop-hold', 'rm-hold', 'save-hold', 'format-fails', 'create-hold', 'exec-hold', 'owned-hold', 'rm-fails', 'filter-fails'].includes(name) || name.startsWith('delay-')) fs.rmSync(path.join(state, name), { force: true });
      }
    },
    failRemove(shouldFail) {
      if (shouldFail) fs.writeFileSync(path.join(state, 'rm-fails'), '');
      else fs.rmSync(path.join(state, 'rm-fails'), { force: true });
    },
    failFilter(shouldFail) {
      if (shouldFail) fs.writeFileSync(path.join(state, 'filter-fails'), '');
      else fs.rmSync(path.join(state, 'filter-fails'), { force: true });
    },
    secret(service, isSet) {
      fs.mkdirSync(path.join(state, 'secrets'), { recursive: true });

      if (isSet) fs.writeFileSync(path.join(state, 'secrets', service), '');
      else fs.rmSync(path.join(state, 'secrets', service), { force: true });
    },
    allowNetwork(target) {
      fs.appendFileSync(path.join(state, 'allowed-network'), `${target}\n`);
    },
    policy(isInitialized) {
      if (isInitialized) fs.rmSync(path.join(state, 'no-policy'), { force: true });
      else fs.writeFileSync(path.join(state, 'no-policy'), '');
    },
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter((line) => line !== '').map((line) => z.array(z.string()).parse(JSON.parse(line))) : []),
    containers: () => stored().map(({ name }) => name),
    labelsOf: (name) => stored().find((container) => container.name === name)?.labels,
    savedImages: () => (fs.existsSync(path.join(state, 'saved')) ? fs.readdirSync(path.join(state, 'saved')).map(decodeURIComponent).sort() : []),
    savedFiles: (tag) => ({ home: filesUnder(path.join(state, 'saved', encodeURIComponent(tag), 'home')), context: filesUnder(path.join(state, 'saved', encodeURIComponent(tag), 'context')) }),
    networks: () => (fs.existsSync(path.join(state, 'networks')) ? fs.readdirSync(path.join(state, 'networks')).sort() : []),
    env: () => ({ PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`, FAKE_ENGINE_STATE: state, FAKE_ENGINE_LOG: log, FAKE_ENGINE_IMAGES: JSON.stringify(images) }),
  };
}

/** A line the runtime wrote, parsed. */
export type Message = Line;

export interface Connection {
  /** The connection `@teamai/runtime-testing` keeps, which its leak check reads. */
  runtime: RuntimeConnection;
  child: RuntimeConnection['child'];
  /** The runtime's executable and the environment it was started with, so another process of it can follow. */
  executable: string;
  env: NodeJS.ProcessEnv;
  send(request: Message): void;
  /** Every request sent so far. */
  sent: Message[];
  /** The next message, from the start of this connection, that `match` accepts and no earlier `next` took. */
  next(match: (message: Message) => boolean, ms?: number): Promise<Message>;
  /** Every message so far. */
  messages: Message[];
  /** Each line the runtime wrote that runtime protocol 1 does not allow, with why. */
  readonly invalid: string[];
  stderr(): string;
  /** Ends stdin and waits until the runtime exits: it outlives its stdin while an exec it runs has not ended. */
  end(): Promise<void>;
}

/** The variables a test environment may leave unset, which a spawned process does not take. */
const DefinedSchema = z.record(z.string(), z.string().optional()).transform((env) => Object.fromEntries(Object.entries(env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]]))));

/** Starts the runtime at `executable` with `env` as its whole environment, as teamai starts one, and speaks to it over its stdio. */
export function connect(executable: string, env: NodeJS.ProcessEnv): Connection {
  const runtime = connectRuntime({ executable, env: DefinedSchema.parse(env) });
  const { child } = runtime;
  const sent: Message[] = [];

  const closed = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('close', () => resolve());
  });

  return {
    runtime,
    child,
    executable,
    env,
    messages: runtime.lines,
    sent,
    get invalid() {
      return runtime.lines.flatMap((line) => {
        const checked = RuntimeMessageSchema.safeParse(line);

        return checked.success ? [] : [`${JSON.stringify(line)}: ${checked.error.message}`];
      });
    },
    stderr: runtime.stderr,
    send: (request) => {
      sent.push(request);
      runtime.send(request);
    },
    next: (match, ms) => runtime.next(match, ms),
    end: async () => {
      child.stdin.end();
      await closed;
    },
  };
}

export function tempDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-sandbox-')));
}
