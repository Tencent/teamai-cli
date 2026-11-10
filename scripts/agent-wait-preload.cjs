// Loaded by scripts/agent-wait-budget.ts into every Node process a measured command starts
// (NODE_OPTIONS=--require). It logs the process and the children it starts, and tags what runs after the hook returns,
// so git's trace2 can tell the two sides apart.
'use strict';

const log = process.env.AGENT_WAIT_NODE_LOG;

if (log && require('node:worker_threads').isMainThread) {
  const fs = require('node:fs');
  const cp = require('node:child_process');

  const write = (record) => {
    try {
      fs.appendFileSync(log, `${JSON.stringify(record)}\n`);
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

  require('node:module').syncBuiltinESMExports();
}
