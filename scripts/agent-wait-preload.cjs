// Loaded by scripts/agent-wait-budget.ts into every Node process a measured command starts
// (NODE_OPTIONS=--require). It logs the process, the children it starts and its file system calls, and tags what runs
// after the hook returns, so git's trace2 can tell the two sides apart.
'use strict';

const log = process.env.AGENT_WAIT_NODE_LOG;

if (log && require('node:worker_threads').isMainThread) {
  const fs = require('node:fs');
  const cp = require('node:child_process');
  const append = fs.appendFileSync;

  const write = (record) => {
    try {
      append(log, `${JSON.stringify(record)}\n`);
    } catch {
      // The measure never fails the process it watches.
    }
  };

  if (process.argv.includes('--bg-only')) process.env.AGENT_WAIT_SIDE = 'after';
  process.env.AGENT_WAIT_FROM = 'node';
  // git sets it for every process it starts; without it teamai's git under a git hook would count as git's own.
  delete process.env.GIT_TRACE2_PARENT_SID;
  write({ ev: 'start', pid: process.pid, argv: process.argv, side: process.env.AGENT_WAIT_SIDE ?? 'waited' });

  // spawn, execFile, exec and fork all reach ChildProcess.prototype.spawn with the environment already built.
  const spawn = cp.ChildProcess.prototype.spawn;

  cp.ChildProcess.prototype.spawn = function agentWaitSpawn(options) {
    const detached = options?.detached === true;

    if (detached && Array.isArray(options.envPairs)) {
      options.envPairs = [...options.envPairs.filter((pair) => !pair.startsWith('AGENT_WAIT_SIDE=')), 'AGENT_WAIT_SIDE=after'];
    }

    const started = spawn.call(this, options);
    write({ ev: 'spawn', pid: process.pid, child: this.pid ?? null, command: [options?.file, ...(options?.args ?? []).slice(1)], detached });

    return started;
  };

  // A synchronous spawn shares no prototype; execFileSync and execSync call spawnSync through a local binding.
  for (const name of ['spawnSync', 'execFileSync', 'execSync']) {
    const original = cp[name];

    cp[name] = function agentWaitSpawnSync(...callArgs) {
      const [file, args] = callArgs;
      write({ ev: 'spawn', pid: process.pid, child: null, command: [file, ...(Array.isArray(args) ? args : [])], detached: false });

      return original.apply(this, callArgs);
    };
  }

  // Each call teamai or a library makes into fs, in callback, sync and promise form; fs's own calls between them are not seen.
  let fsCalls = 0;
  const FS_CALLS = ['access', 'appendFile', 'chmod', 'copyFile', 'cp', 'lstat', 'mkdir', 'mkdtemp', 'open', 'opendir', 'readdir', 'readFile', 'readlink', 'realpath', 'rename', 'rm', 'rmdir', 'stat', 'symlink', 'unlink', 'utimes', 'writeFile'];

  // Keeps the function's own properties: callers reach realpath's `.native` through them.
  const counted = (original) => Object.assign(function agentWaitFsCall(...callArgs) {
    fsCalls++;

    return original.apply(this, callArgs);
  }, original);

  const count = (owner, name) => {
    const original = owner[name];
    owner[name] = counted(original);

    if (original.native) owner[name].native = counted(original.native);
  };

  for (const name of FS_CALLS) {
    count(fs, name);
    count(fs, `${name}Sync`);
    count(fs.promises, name);
  }

  count(fs, 'existsSync');
  process.on('exit', () => write({ ev: 'fs', pid: process.pid, calls: fsCalls }));

  require('node:module').syncBuiltinESMExports();

  // Process identity is read from /proc on Linux and through ps elsewhere (@teamai/shared/process-group tells each read
  // on this channel). A read /proc answered is logged as the ps macOS runs for it, so a Linux runner counts the same
  // waits; a read that ran ps is already logged by its spawn.
  require('node:diagnostics_channel').subscribe('teamai:process-read', (read) => {
    if (read?.spawned === false && Array.isArray(read.ps)) write({ ev: 'spawn', pid: process.pid, child: null, command: ['ps', ...read.ps], detached: false });
  });
}
