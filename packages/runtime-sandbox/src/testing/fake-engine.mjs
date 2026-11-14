#!/usr/bin/env node
// A stand-in `docker` / `podman` / `sbx` for tests: the subset of each CLI its provider runs, against a state
// directory instead of a daemon. An sbx sandbox is kept as a container whose image is its agent, mounted at its
// workspaces' host paths. A container's processes run on the host, in a process group of their own, with only
// the environment a real container would give them: the image's PATH, the `--env` of `run`, and each `-e NAME` of
// `exec` taken from this process's own environment. An `exec` whose working directory no mount covers fails as it
// would in a container; one that a mount covers runs in that mount's host directory. Every argv is appended to
// FAKE_ENGINE_LOG as one JSON line; no environment value is written.
//
//   FAKE_ENGINE_STATE   its state directory; a file `down` there makes it answer as a stopped daemon, a file
//                       `rm-fails` makes `rm` fail as a daemon that cannot remove the container, `filter-fails` makes
//                       `run` of a network filter (`<name>-proxy`) fail as a daemon that cannot start it, a file `no-policy`
//                       makes sbx answer as one whose network policy was never initialized, and a file
//                       `secrets/<service>` is an sbx secret its proxy holds; a file `stop-lag` holding a number of
//                       milliseconds makes an `exec` whose process was stopped end that much later, as a real exec
//                       client notices its container stopped only after the stop command returns; a file
//                       `stop-delay` holding a number of milliseconds makes `restart` (sbx: `stop`) wait that long
//                       before it stops anything, as a daemon that is slow to answer; a file `stop-hold` holding a
//                       number of milliseconds makes it wait that long once it stopped the processes, before it
//                       answers, as an engine that restarts the container does; a file `rm-hold` holding a number of
//                       milliseconds makes docker's `rm` wait that long once it stopped the processes, before the
//                       container is gone, while another `rm` of it fails as already in progress; a file `delay-<command>`
//                       holding a number of milliseconds makes that command (`run`, `rm`, …) wait that long first;
//                       a file `save-hold` holding a number of milliseconds makes a `commit`, `build` or sbx `template save`
//                       wait that long while it writes the image, as a save still on its way;
//                       a file `format-fails` makes `ps --format` fail as an engine that cannot render it; a file
//                       `version` holding a version makes `version` print it, as an upgraded engine does; a file
//                       `create-hold` holding a number of milliseconds makes `run -d` wait that long after the container
//                       exists, before it answers, as a create still on its way; a file `exec-hold` holding a number
//                       of milliseconds makes docker's or podman's `exec` wait that long once it found its container, before it
//                       starts the process, as an exec still on its way to the daemon (sbx's `exec` waits before it
//                       looks its sandbox up, and starts a stopped one again, as sbx does); a file `owned-hold` makes a `ps`
//                       filtered by `teamai.owner` wait until it is removed (60 s at most), with a file `owned-listing`
//                       there while it waits; each list of one journal's containers it answered adds a character to
//                       a file `owned-listed`
//   FAKE_ENGINE_IMAGES  JSON: image (or sbx agent) name -> the directory its tools are in (the image's PATH)
//   FAKE_ENGINE_NAME    docker, podman or sbx, which it answers as
//   FAKE_ENGINE_LOG     optional: where argv lines go
//   FAKE_ENGINE_VERSION optional: the server version `info` reports, 27.3.1 when unset
//   FAKE_ENGINE_OS      optional: the OperatingSystem docker's `info` reports, "Docker Desktop" when unset
//   FAKE_ENGINE_HOST    optional: the host name docker's `info` reports for its daemon (`Name`), this machine's when unset
//
//  A saved image (docker `commit` or `build`, sbx `template save`) keeps the home of the container it was saved from,
//  under `saved/<tag>/home`, and the base whose tools it holds; a container created from it starts with a copy of that
//  home. `build` keeps the files of its context under `saved/<tag>/context`, and takes its base from the Containerfile's
//  FROM line.
//
//  What it does not model: a read-only mount stays writable, since its processes run on the host. The container
//  provider spec (providers/container-spec.test.ts) runs the same cases on a real engine, which checks that one.
//
//  sbx answers `policy check network --json <target>` from a file `allowed-network` in its state directory, one
//  `localhost:<port>` per line, as `sbx policy allow network` adds them; host.docker.internal is checked as localhost.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = process.env.FAKE_ENGINE_STATE;
const images = JSON.parse(process.env.FAKE_ENGINE_IMAGES ?? '{}');
const args = process.argv.slice(2);
const engine = process.env.FAKE_ENGINE_NAME ?? 'docker';

if (process.env.FAKE_ENGINE_LOG) fs.appendFileSync(process.env.FAKE_ENGINE_LOG, `${JSON.stringify([engine, ...args])}\n`);

const containers = path.join(state, 'containers');

fs.mkdirSync(containers, { recursive: true });

/**
 * A `-v SOURCE:TARGET[:MODE]`, as docker reads it on any host: a source may start with a Windows drive (`C:\\…`,
 * `C:/…`), whose colon is not a separator.
 */
function mountOf(volume) {
  const [, source, target, mode = ''] = /^((?:[A-Za-z]:[\\/])?[^:]*):([^:]+)(?::([^:]*))?$/.exec(volume) ?? fail(`invalid volume specification: '${volume}'`, 125);

  return { source, target, readonly: mode.split(',').includes('ro') };
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function readContainer(ref) {
  for (const id of fs.readdirSync(containers)) {
    let container;

    // A removal may take it between the listing and the read.
    try { container = JSON.parse(fs.readFileSync(path.join(containers, id, 'container.json'), 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }

    if (id === ref || container.name === ref) return container;
  }

  return undefined;
}

/** Records a new container, with its home and the list of its processes. */
function createContainer(container) {
  for (const part of ['home', 'execs', 'tmp']) fs.mkdirSync(path.join(containers, container.id, part), { recursive: true });
  writeContainer(container);
}

/** Rewrites a container's record, and answers false when a removal took the container meanwhile, never bringing it back. */
function writeContainer(container) {
  const file = path.join(containers, container.id, 'container.json');

  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(container));
    fs.renameSync(`${file}.tmp`, file);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }

  return true;
}

/**
 * Sends `name` to process group `pgid`: never to one below 2, which kill reads as this program's own group (0), every
 * process it may signal (-1), or init (1). node runs this program as it is, so it cannot load
 * @teamai/shared/process-group, whose check this is.
 */
function signalGroup(pgid, name) {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return;

  try { process.kill(-pgid, name); } catch { /* gone */ }
}

/**
 * Starts `container` again, as docker's `start` does. Docker Desktop (29.4.3) makes each bind source that is gone again,
 * as an empty directory, before the container runs; podman refuses the start instead, which this does not model.
 */
function startContainer(container) {
  // One a removal took meanwhile is not started.
  if (writeContainer({ ...container, running: true }) && engine === 'docker') for (const { source } of container.mounts) fs.mkdirSync(source, { recursive: true });
}

/** Stops every process group an exec of the container whose directory is `dir` started, as a container stop does. */
function killProcesses(dir) {
  let pids;

  try { pids = fs.readdirSync(path.join(dir, 'execs')); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const name of pids) {
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      signalGroup(Number(name), signal);
    }

    fs.rmSync(path.join(dir, 'execs', name), { force: true });
  }
}

/**
 * Removes the container and stops its processes, as `rm --force` does, and answers false when another removal took it
 * first. Its directory leaves `containers` in one rename before anything else, so the container is gone at once and a
 * late writer finds no path into it: an exec that found it and starts its process meanwhile ends that process
 * (runProcess), and a process writing into its home can neither bring it back nor keep its removal from finishing.
 */
function removeContainer(container) {
  const removed = path.join(state, 'removed', `${container.id}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(path.dirname(removed), { recursive: true });

  try { fs.renameSync(path.join(containers, container.id), removed); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }

  killProcesses(removed);
  fs.rmSync(removed, { recursive: true, force: true, maxRetries: 3 });

  return true;
}

/** Splits `args` into the options of a subcommand (flags with a value) and the rest, from the first positional. */
function options(list, withValue, boolean = []) {
  const found = [];
  let at = 0;

  while (at < list.length && list[at].startsWith('-')) {
    const flag = list[at];

    if (boolean.includes(flag)) {
      found.push([flag, true]);
      at += 1;
    } else if (withValue.includes(flag)) {
      found.push([flag, list[at + 1]]);
      at += 2;
    } else {
      fail(`fake engine: unknown flag ${flag}`, 125);
    }
  }

  return { found, rest: list.slice(at) };
}

function all(found, flag) {
  return found.filter(([name]) => name === flag).map(([, value]) => value);
}

function one(found, flag) {
  return all(found, flag).at(-1);
}

/** Where a saved image's record is: its base and home. */
function savedDir(tag) {
  return path.join(state, 'saved', encodeURIComponent(tag));
}

/**
 * Saves `home`, and the build context `context` when given, as image `tag` on `base`, which holds its tools. The image
 * appears whole, as an engine's tag does once its commit is done: a removal seen after it is not undone by the save.
 */
function saveImage(tag, base, home, context) {
  const staged = path.join(state, 'saving', `${encodeURIComponent(tag)}-${process.pid}`);
  fs.mkdirSync(staged, { recursive: true });
  fs.writeFileSync(path.join(staged, 'base'), base);
  fs.writeFileSync(path.join(staged, 'engine'), engine);

  if (fs.existsSync(home)) fs.cpSync(home, path.join(staged, 'home'), { recursive: true, verbatimSymlinks: true });

  if (context !== undefined) fs.cpSync(context, path.join(staged, 'context'), { recursive: true });

  waitAsLongAs('save-hold');
  fs.mkdirSync(path.join(state, 'pulled'), { recursive: true });
  fs.writeFileSync(path.join(state, 'pulled', encodeURIComponent(tag)), '');
  fs.mkdirSync(path.join(state, 'saved'), { recursive: true });
  fs.rmSync(savedDir(tag), { recursive: true, force: true });
  fs.renameSync(staged, savedDir(tag));
}

/** The tags this engine saved: docker's, podman's and sbx's stores are their own. */
function savedTags() {
  const root = path.join(state, 'saved');

  return (fs.existsSync(root) ? fs.readdirSync(root) : []).filter((name) => fs.readFileSync(path.join(root, name, 'engine'), 'utf8') === engine).map(decodeURIComponent);
}

/** Removes the image `tag` this engine saved; false when it saved none of that tag. */
function removeSaved(tag) {
  if (!savedTags().includes(tag)) return false;
  fs.rmSync(savedDir(tag), { recursive: true, force: true });
  fs.rmSync(path.join(state, 'pulled', encodeURIComponent(tag)), { force: true });

  return true;
}

/** sbx 0.53's id of a template: `sha256:` and 64 hex. */
function templateId(tag) {
  return `sha256:${crypto.createHash('sha256').update(tag).digest('hex')}`;
}

/** The image whose tools `image` holds: itself, or a saved image's base. */
function toolsOf(image) {
  const base = path.join(savedDir(image), 'base');

  return images[image] ?? (fs.existsSync(base) ? images[fs.readFileSync(base, 'utf8')] : undefined);
}

/** Gives a new container the home of the saved image it starts from, when it is one. */
function seedHome(id, image) {
  const saved = path.join(savedDir(image), 'home');

  if (fs.existsSync(saved)) fs.cpSync(saved, path.join(containers, id, 'home'), { recursive: true, verbatimSymlinks: true });
}

function imagePath(image) {
  return `${toolsOf(image)}${path.delimiter}/usr/bin${path.delimiter}/bin`;
}

/** An image's id, which follows what it holds: the same tag pushed again with other tools has another. */
function imageId(image) {
  const hash = crypto.createHash('sha256').update(image);
  const dir = images[image];

  if (dir !== undefined && fs.existsSync(dir)) for (const name of fs.readdirSync(dir).sort()) hash.update(`\0${name}\0`).update(fs.readFileSync(path.join(dir, name)));

  return `sha256:${hash.digest('hex')}`;
}

function pulled(image) {
  return fs.existsSync(path.join(state, 'pulled', encodeURIComponent(image)));
}

/**
 * Runs `argv` in `cwd` with `env` as one of the container's processes, and exits as it does. The pid file a provider
 * keeps in the container's /tmp (providers/cli.ts `signalled`) goes into the container's own folder, as a container's
 * /tmp is its own, not the host's.
 */
function runProcess(container, argv, cwd, env, stdin) {
  const tmp = path.join(containers, container.id, 'tmp');
  const inContainer = argv.map((arg) => arg.replaceAll(/\/tmp\/(teamai-tool-[0-9a-f]+\.pid)/g, (_, name) => path.join(tmp, name)));
  const child = spawn(inContainer[0], inContainer.slice(1), { cwd, env, detached: true, stdio: [stdin ? 'inherit' : 'ignore', 'inherit', 'inherit'] });
  const execs = path.join(containers, container.id, 'execs');
  child.on('spawn', () => {
    // A process cannot outlive its container: one that starts as the container is removed cannot be written down, so
    // the removal never lists it, and it ends here. One written down before is in what the removal lists.
    try { fs.writeFileSync(path.join(execs, String(child.pid)), ''); } catch (error) {
      if (error.code !== 'ENOENT') throw error;

      signalGroup(Number(child.pid), 'SIGKILL');
    }
  });
  child.on('error', (error) => fail(`OCI runtime exec failed: ${error.message}: executable file not found in $PATH`, 127));
  child.on('close', (code, signal) => {
    fs.rmSync(path.join(execs, String(child.pid)), { force: true });
    const lag = signal && fs.existsSync(path.join(state, 'stop-lag')) ? Number(fs.readFileSync(path.join(state, 'stop-lag'), 'utf8')) : 0;
    setTimeout(() => process.exit(signal ? 128 + (signal === 'SIGKILL' ? 9 : 15) : code ?? 1), lag);
  });

  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {});
}

/** Waits as long as the file `name` in the state directory says, when there is one. */
function waitAsLongAs(name) {
  const file = path.join(state, name);

  if (fs.existsSync(file)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(fs.readFileSync(file, 'utf8')));
}


const [command, ...rest] = args;
const commandDelay = path.join(state, `delay-${command}`);

if (fs.existsSync(commandDelay)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(fs.readFileSync(commandDelay, 'utf8')));

if (command === '--version' || command === 'version') {
  const version = path.join(state, 'version');
  process.stdout.write(`${engine} version ${fs.existsSync(version) ? fs.readFileSync(version, 'utf8') : '0.0.0-fake'}\n`);
  process.exit(0);
}

if (engine === 'sbx') sbx();
else docker();

/** Answers as docker or podman. */
function docker() {
  if (fs.existsSync(path.join(state, 'down'))) fail(`Cannot connect to the ${engine === 'podman' ? 'Podman' : 'Docker'} daemon. Is the daemon running?`);

  switch (command) {
    case 'info': {
      // Each engine's own template field for its version.
      const format = rest[rest.indexOf('--format') + 1] ?? '';

      if (format.includes(engine === 'podman' ? 'ServerVersion' : 'Version.Version')) fail(`Error: template: info:1:2: executing "info" at <${format}>: can't evaluate field`, 125);
      const version = process.env.FAKE_ENGINE_VERSION ?? (engine === 'podman' ? '5.2.3' : '27.3.1');
      process.stdout.write(`${format.replace('{{.ServerVersion}}', version).replace('{{.Version.Version}}', version).replace('{{.OperatingSystem}}', process.env.FAKE_ENGINE_OS ?? 'Docker Desktop').replace('{{.Name}}', process.env.FAKE_ENGINE_HOST ?? os.hostname())}\n`);
      break;
    }

    case 'image': {
      if (rest[0] === 'rm') {
        const [, tag] = rest;

        if (!removeSaved(tag)) fail(engine === 'podman' ? `Error: ${tag}: image not known` : `Error response from daemon: No such image: ${tag}`);
        process.stdout.write(`Untagged: ${tag}\n`);
        break;
      }

      const [, , , image] = rest;

      if (rest[0] !== 'inspect' || !pulled(image)) fail(`Error: No such image: ${image}`);
      process.stdout.write(`${imageId(image)}\n`);
      break;
    }

    case 'pull': {
      const [image] = rest;

      if (images[image] === undefined) fail(`Error response from daemon: pull access denied for ${image}, repository does not exist`);
      fs.mkdirSync(path.join(state, 'pulled'), { recursive: true });
      fs.writeFileSync(path.join(state, 'pulled', encodeURIComponent(image)), '');
      break;
    }

    case 'run': {
      const { found, rest: positional } = options(rest, ['--name', '--label', '--user', '--userns', '--env', '-v', '--entrypoint', '--network', '--cap-drop', '--security-opt', '--add-host'], ['-d', '--rm']);
      const [image, ...entry] = positional;

      if (!pulled(image)) fail(`Unable to find image '${image}' locally`, 125);

      if (one(found, '--rm')) {
        // A probe: run the entrypoint once, on the image's PATH.
        const probe = spawn(one(found, '--entrypoint'), entry, { env: { PATH: imagePath(image) }, stdio: ['ignore', 'inherit', 'inherit'] });
        probe.on('close', (code) => process.exit(code ?? 1));
        break;
      }

      const name = one(found, '--name');

      if (name?.endsWith('-proxy') && fs.existsSync(path.join(state, 'filter-fails'))) fail(`docker: Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: ${name}.`, 125);

      if (name && readContainer(name)) fail(`Conflict. The container name "/${name}" is already in use.`, 125);
      const network = one(found, '--network');

      if (network && !fs.existsSync(path.join(state, 'networks', network))) fail(`Error response from daemon: network ${network} not found`, 125);
      const id = crypto.randomBytes(16).toString('hex');
      const hold = path.join(state, 'create-hold');

      createContainer({
        id, name, image, running: true,
        labels: Object.fromEntries(all(found, '--label').map((label) => label.split(/=(.*)/s).slice(0, 2))),
        env: Object.fromEntries(all(found, '--env').map((pair) => pair.split(/=(.*)/s).slice(0, 2))),
        mounts: all(found, '-v').map(mountOf),
      });

      seedHome(id, image);

      if (fs.existsSync(hold)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(fs.readFileSync(hold, 'utf8')));
      process.stdout.write(`${id}\n`);
      break;
    }

    case 'commit': {
      const [ref, tag] = rest;
      const container = readContainer(ref);

      if (!container) fail(`Error response from daemon: No such container: ${ref}`);
      saveImage(tag, container.image, path.join(containers, container.id, 'home'));
      process.stdout.write(`sha256:${crypto.createHash('sha256').update(tag).digest('hex')}\n`);
      break;
    }

    case 'build': {
      const { found, rest: [context] } = options(rest, ['-t', '-f']);
      const tag = one(found, '-t');
      const from = /^FROM\s+(\S+)/m.exec(fs.readFileSync(one(found, '-f'), 'utf8'))?.[1];

      if (from === undefined || toolsOf(from) === undefined) fail(`ERROR: failed to solve: ${from}: not found`);
      saveImage(tag, from, path.join(state, 'no-home'), context);
      process.stdout.write(`naming to ${tag} done\n`);
      break;
    }

    case 'ps': {
      const { found } = options(rest, ['--filter', '--format'], ['-a', '-q']);

      if (one(found, '--format') !== undefined && fs.existsSync(path.join(state, 'format-fails'))) fail('Error: template: ps:1: function "Label" not defined', 125);
      const wanted = all(found, '--filter').map((filter) => filter.replace(/^label=/, '').split(/=(.*)/s).slice(0, 2));

      // A list of one journal's containers waits while `owned-hold` exists, marked `owned-listing` meanwhile.
      if (wanted.some(([key]) => key === 'teamai.owner') && fs.existsSync(path.join(state, 'owned-hold'))) {
        fs.writeFileSync(path.join(state, 'owned-listing'), '');

        for (let waited = 0; waited < 60_000 && fs.existsSync(path.join(state, 'owned-hold')); waited += 50) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        fs.rmSync(path.join(state, 'owned-listing'), { force: true });
      }

      // The fields of `--format` the providers use: the id and a label's value, empty when it has none.
      const format = one(found, '--format') ?? '{{.ID}}';

      for (const id of fs.readdirSync(containers)) {
        const container = readContainer(id);

        if (container && wanted.every(([key, value]) => container.labels[key] === value)) process.stdout.write(`${format.replaceAll('{{.ID}}', container.id).replace(/\{\{\.Label "([^"]+)"\}\}/g, (_, key) => container.labels[key] ?? '')}\n`);
      }

      if (wanted.some(([key]) => key === 'teamai.owner')) fs.appendFileSync(path.join(state, 'owned-listed'), '.');

      break;
    }

    case 'exec': {
      const { found, rest: positional } = options(rest, ['-w', '-e', '--user'], ['-i']);
      const [ref, ...argv] = positional;
      const container = readContainer(ref);

      if (!container) fail(`Error response from daemon: No such container: ${ref}`);

      if (!container.running) fail(`Error response from daemon: container ${container.id} is not running`);
      waitAsLongAs('exec-hold');

      // Removed while this exec was on its way: it answers as the daemon does for a container that is not there.
      if (!readContainer(ref)) fail(`Error response from daemon: No such container: ${ref}`);
      const cwd = one(found, '-w') ?? '/';
      // The process runs on the host, so it starts in the host directory mounted where the container's cwd is.
      const mount = container.mounts.filter(({ target }) => cwd === target || cwd.startsWith(`${target}/`)).sort((a, b) => b.target.length - a.target.length)[0];

      if (!mount) fail(`OCI runtime exec failed: chdir to cwd ("${cwd}") set in config.json failed: no such file or directory`, 126);
      const home = path.join(containers, container.id, 'home');
      const env = { PATH: imagePath(container.image), ...container.env, HOME: home };

      for (const name of all(found, '-e')) if (process.env[name] !== undefined) env[name] = process.env[name];
      runProcess(container, argv, mount.source + cwd.slice(mount.target.length), env, one(found, '-i'));
      break;
    }

    case 'restart': {
      waitAsLongAs('stop-delay');
      const { rest: positional } = options(rest, ['--time', '-t']);
      const container = readContainer(positional[0]);

      if (!container) fail(`Error response from daemon: No such container: ${positional[0]}`);
      killProcesses(path.join(containers, container.id));
      waitAsLongAs('stop-hold');
      startContainer(container);
      process.stdout.write(`${positional[0]}\n`);
      break;
    }

    case 'inspect': {
      // The one template the container provider asks for: each bind mount's host path, one per line.
      const { found, rest: positional } = options(rest, ['--type', '--format']);
      const container = readContainer(positional[0]);

      if (one(found, '--type') !== 'container' || !one(found, '--format')?.includes('.Mounts')) fail(`fake ${engine}: inspect answers only --type container --format with .Mounts`);

      if (!container) fail(`Error: No such container: ${positional[0]}`);
      process.stdout.write(container.mounts.map(({ source }) => `${source}\n`).join(''));
      break;
    }

    case 'rm': {
      const { rest: positional } = options(rest, [], ['--force', '-f']);
      const container = readContainer(positional[0]);

      if (fs.existsSync(path.join(state, 'rm-fails'))) fail(`Error response from daemon: cannot remove container "${positional[0]}": could not kill: tried to kill container, but did not receive an exit event`);

      if (container?.removing) fail(`Error response from daemon: removal of container ${container.id} is already in progress`);

      if (container && fs.existsSync(path.join(state, 'rm-hold'))) {
        writeContainer({ ...container, running: false, removing: true });
        killProcesses(path.join(containers, container.id));
        waitAsLongAs('rm-hold');
      }

      if (!container || !removeContainer(container)) fail(`Error response from daemon: No such container: ${positional[0]}`);
      process.stdout.write(`${positional[0]}\n`);
      break;
    }

    case 'network': {
      // Networks are names only: a container's processes run on the host either way.
      const [action, ...more] = rest;
      const networks = path.join(state, 'networks');
      fs.mkdirSync(networks, { recursive: true });

      if (action === 'create') {
        const { found, rest: [name] } = options(more, ['--label', '-o'], ['--internal']);

        if (fs.existsSync(path.join(networks, name))) fail(`Error response from daemon: network with name ${name} already exists`);
        // A network keeps its labels, which `network ls --filter label=` reads.
        fs.writeFileSync(path.join(networks, name), JSON.stringify(Object.fromEntries(all(found, '--label').map((label) => label.split(/=(.*)/s).slice(0, 2)))));
        process.stdout.write(`${crypto.randomBytes(16).toString('hex')}\n`);
      } else if (action === 'connect') {
        const [name, ref] = more;

        if (!fs.existsSync(path.join(networks, name))) fail(`Error response from daemon: network ${name} not found`);

        if (!readContainer(ref)) fail(`Error response from daemon: No such container: ${ref}`);
      } else if (action === 'ls') {
        // `network ls --filter label=<key>=<value> --format {{.Name}}`, the one listing the providers make.
        const { found } = options(more, ['--filter', '--format']);
        const wanted = all(found, '--filter').map((filter) => filter.replace(/^label=/, '').split(/=(.*)/s).slice(0, 2));

        for (const name of fs.readdirSync(networks).sort()) {
          const text = fs.readFileSync(path.join(networks, name), 'utf8');
          const labels = text === '' ? {} : JSON.parse(text);

          if (wanted.every(([key, value]) => labels[key] === value)) process.stdout.write(`${name}\n`);
        }
      } else if (action === 'rm') {
        const [name] = more;

        if (!fs.existsSync(path.join(networks, name))) fail(`Error response from daemon: network ${name} not found`);
        fs.rmSync(path.join(networks, name));
        process.stdout.write(`${name}\n`);
      } else {
        fail(`fake engine: unsupported network command ${action}`, 125);
      }

      break;
    }

    default:
      fail(`fake engine: unsupported command ${command}`, 125);
  }
}

/** The sbx placeholders a sandbox's env holds for the logins its proxy injects, never a value. */
function proxyEnv() {
  const env = { GH_TOKEN: 'proxy-managed' };

  if (fs.existsSync(path.join(state, 'secrets', 'openai'))) env.OPENAI_API_KEY = 'proxy-managed';

  if (fs.existsSync(path.join(state, 'secrets', 'anthropic'))) env.ANTHROPIC_API_KEY = 'proxy-managed';

  return env;
}

/** Answers as sbx 0.50.1, with its messages: `error: …` then `  try: …`, the shape sbx 0.53.0 still prints. */
function sbx() {
  const sbxFail = (message, hint, code = 1) => fail(`error: ${message}${hint ? `\n  try: ${hint}` : ''}`, code);

  if (fs.existsSync(path.join(state, 'down'))) sbxFail('cannot connect to sandboxd: connection refused', 'sbx daemon start');

  if (['create', 'policy'].includes(command) && fs.existsSync(path.join(state, 'no-policy'))) sbxFail('global network policy has not been initialized', 'sbx policy init <allow-all|balanced|deny-all>');

  const sandboxes = () => fs.readdirSync(containers).map(readContainer).filter((container) => container !== undefined);

  switch (command) {
    case 'policy': {
      if (rest[0] !== 'check') {
        process.stdout.write('local-policy   local   all   network: 195 allow\n');
        break;
      }

      // `sbx policy check network --json <target>`, as sbx 0.51.0 answers it: exit 1 when it is not allowed.
      const target = rest.at(-1).replace(/^host\.docker\.internal:/, 'localhost:');
      const allowed = fs.existsSync(path.join(state, 'allowed-network')) && fs.readFileSync(path.join(state, 'allowed-network'), 'utf8').split('\n').includes(target);
      process.stdout.write(`${JSON.stringify({ action: 'net:connect:tcp', allowed, context: 'global', resource_value: target, target, type: 'network', ...(!allowed && { reason: 'No matching allow rule (default deny)' }) })}\n`);
      process.exit(allowed ? 0 : 1);
    }

    case 'secret': {
      // `sbx secret ls --global --json`, as sbx 0.51.0 prints it (0.53.0 prints the same four keys): each stored secret's
      // scope, type and service, its value masked.
      if (rest[0] !== 'ls' || !rest.includes('--json')) fail(`fake sbx: unsupported secret command ${rest.join(' ')}`, 125);
      const stored = fs.existsSync(path.join(state, 'secrets')) ? fs.readdirSync(path.join(state, 'secrets')) : [];
      process.stdout.write(`${JSON.stringify({ secrets: stored.map((name) => ({ scope: 'global', type: 'service', name, secret: '********' })), custom_secrets: [], shadowed_services: [], env_only_count: 0 })}\n`);
      break;
    }

    case 'template': {
      const [action, ...more] = rest;

      // sbx 0.53 lists a template under docker.io/library/<name>, and keeps a kit's base it assembled as
      // sandbox-kit-assembled:<hash>, which a template saved from a sandbox of it shares its id with.
      const kits = path.join(state, 'kits');

      const listed = (ref, id) => {
        const at = ref.lastIndexOf(':');

        return { id, repository: ref.slice(0, at), tag: ref.slice(at + 1), digest: id, flavor: 'shell', created_at: '2026-11-13T10:58:00Z', size: 214908963 };
      };

      if (action === 'ls') {
        const assembled = fs.existsSync(kits) ? fs.readdirSync(kits).map((name) => listed(decodeURIComponent(name), fs.readFileSync(path.join(kits, name), 'utf8'))) : [];
        process.stdout.write(`${JSON.stringify([listed('docker.io/docker/sandbox-templates:claude-code-docker', templateId('claude-code-docker')), ...savedTags().map((tag) => listed(`docker.io/library/${tag}`, templateId(tag))), ...assembled])}\n`);
      } else if (action === 'save') {
        const [name, tag] = more;
        const sandbox = readContainer(name);

        if (!sandbox) sbxFail(`sandbox '${name}' not found`, 'sbx ls');
        saveImage(tag, sandbox.image, path.join(containers, sandbox.id, 'home'));
        fs.mkdirSync(kits, { recursive: true });
        fs.writeFileSync(path.join(kits, encodeURIComponent(`docker.io/library/sandbox-kit-assembled:${crypto.createHash('sha256').update(sandbox.image).digest('hex').slice(0, 16)}`)), templateId(tag));
        process.stdout.write(`Saved sandbox ${name} as ${tag}\n`);
      } else if (action === 'rm') {
        const ref = more.find((arg) => arg !== '--force' && arg !== '-f') ?? '';
        const kit = path.join(kits, encodeURIComponent(ref));

        if (fs.existsSync(kit)) fs.rmSync(kit);
        else if (!removeSaved(ref.replace(/^docker\.io\/library\//, ''))) fail(`error: cannot remove template "${ref}": delete template: image not found: request failed: 404 Not Found: no image "${ref}"`);
        process.stdout.write(`Removed template ${ref}\n`);
      } else {
        fail(`fake sbx: unsupported template command ${action}`, 125);
      }

      break;
    }

    case 'ls':
      process.stdout.write(`${JSON.stringify(sandboxes().map(({ name, image, running, mounts }) => ({ name, agent: image, status: running ? 'running' : 'stopped', workspaces: mounts.map(({ source, readonly }) => `${source}${readonly ? ':ro' : ''}`) })))}\n`);
      break;
    case 'create': {
      const { found, rest: positional } = options(rest, ['--name', '-e', '--env', '-t', '--template'], ['--no-progress']);
      const [agent, ...paths] = positional;
      const template = one(found, '-t') ?? one(found, '--template');

      if (images[agent] === undefined) sbxFail(`unknown agent "${agent}"`, 'sbx create --help');

      if (template !== undefined && !fs.existsSync(path.join(savedDir(template), 'base'))) sbxFail(`template ${template} not found in the local image store`, 'sbx template ls');
      const name = one(found, '--name') ?? `${agent}-${path.basename(paths[0] ?? 'none')}`;

      if (readContainer(name)) sbxFail(`sandbox '${name}' already exists; connect to the existing sandbox`, `sbx run --name ${name}`);

      const mounts = paths.map((entry) => {
        const readonly = entry.endsWith(':ro');
        const source = readonly ? entry.slice(0, -3) : entry;

        if (!fs.existsSync(source)) sbxFail(`workspace ${source} does not exist`);

        return { source, target: source, readonly };
      });

      const id = crypto.randomBytes(16).toString('hex');
      createContainer({ id, name, image: agent, running: true, labels: {}, env: proxyEnv(), mounts });

      if (template !== undefined) seedHome(id, template);

      // sbx's claude template keeps Claude's sign-in in its default home as a stand-in the proxy swaps for the login.
      if (fs.existsSync(path.join(images[agent], 'claude'))) {
        fs.mkdirSync(path.join(containers, id, 'home', '.claude'), { recursive: true });
        fs.writeFileSync(path.join(containers, id, 'home', '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"proxy-managed"}}');
      }

      process.stdout.write(`  ✓ Created sandbox ${name}\n`);
      break;
    }

    case 'exec': {
      const { found, rest: positional } = options(rest, ['-w', '--workdir', '-e', '--env', '-u', '--user'], ['-i', '-t']);
      const [name, ...argv] = positional;
      // Held before the lookup: sbx starts a stopped sandbox again for an exec that reaches it after a stop.
      waitAsLongAs('exec-hold');
      const sandbox = readContainer(name);

      if (!sandbox) sbxFail(`sandbox '${name}' not found`, 'sbx ls', 125);

      if (!sandbox.running) {
        if (!writeContainer({ ...sandbox, running: true })) sbxFail(`sandbox '${name}' not found`, 'sbx ls', 125);
        process.stderr.write(`  ✓ sandbox ${name} — started\n`);
      }

      const home = path.join(containers, sandbox.id, 'home');
      // Without -w, a process starts in the primary workspace, or in the agent's home when the sandbox has none.
      const cwd = one(found, '-w') ?? sandbox.mounts[0]?.target;
      const mount = cwd === undefined ? { source: home, target: '' } : sandbox.mounts.filter(({ target }) => cwd === target || cwd.startsWith(`${target}/`)).sort((a, b) => b.target.length - a.target.length)[0];

      if (!mount) fail(`OCI runtime exec failed: chdir to cwd ("${cwd}") set in config.json failed: no such file or directory`, 126);
      const env = { PATH: imagePath(sandbox.image), ...sandbox.env, HOME: home };

      for (const variable of all(found, '-e')) if (process.env[variable] !== undefined) env[variable] = process.env[variable];
      runProcess(sandbox, argv, mount.source + (cwd ?? '').slice(mount.target.length), env, one(found, '-i'));

      return;
    }

    case 'stop': {
      waitAsLongAs('stop-delay');

      for (const name of rest) {
        const sandbox = readContainer(name);

        if (!sandbox) sbxFail(`sandbox '${name}' not found`, 'sbx ls');
        killProcesses(path.join(containers, sandbox.id));

        if (!writeContainer({ ...sandbox, running: false })) sbxFail(`sandbox '${name}' not found`, 'sbx ls');
        waitAsLongAs('stop-hold');
        process.stdout.write(`Stopped sandbox ${name}\n`);
      }

      break;
    }

    case 'rm': {
      const { rest: names } = options(rest, [], ['--force', '-f']);

      if (fs.existsSync(path.join(state, 'rm-fails'))) sbxFail(`failed to remove sandbox '${names[0]}': sandboxd: context deadline exceeded`);

      for (const name of names) {
        const sandbox = readContainer(name);

        if (!sandbox || !removeContainer(sandbox)) sbxFail(`sandbox '${name}' not found`, 'sbx ls');
        process.stdout.write(`Removed sandbox ${name}\n`);
      }

      break;
    }

    default:
      fail(`fake sbx: unsupported command ${command}`, 125);
  }

  process.exit(0);
}
