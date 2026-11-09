import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runLedger } from './ledger.js';
import { checkoutStatus, createWorld, git, liveWorlds, loadWorld, REPO_ROOT, runInWorld, saveWorld, TEAM_URL, TOOL_COMMANDS, type World } from './world.js';

const HELP = `Verify a teamai change end to end: the real CLI, packed and installed, in an isolated world.

  npm run verify:world                        build, pack, create a world; print its run id alone on stdout
  npm run -s verify -- doctor [run]           node, git and each tool on PATH; whether the world matches the checkout
  npm run -s verify -- teamai <run> <args>    the world's installed teamai, in its project
  npm run -s verify -- sh <run> <cmd> [args]  any command in the world (git, claude -p, a second checkout)
  npm run -s verify -- ledger <run>           uninstall teamai in the world, then what is left, in LEDGER-<n>.md; exit 1 on any LEAK
  npm run -s verify -- cleanup <run>|--all    remove the world, keeping world.json, logs/ and every ledger
  npm run -s verify -- dir <run>|--all        the world's directory, or every live world

A world holds a project repo with one commit, a bare team repo at ${TEAM_URL}, the npm pack tarball of
this checkout installed on its own, and a HOME and TMPDIR of its own. Commands get an environment built from
nothing: no tool home (CLAUDE_CONFIG_DIR, CODEX_HOME, ...) or TEAMAI_* variable of your shell reaches them. Set one
on the command line when the claim needs it: \`sh <run> env CODEX_HOME=... teamai pull\`.

A world freezes the build it was made from. Change teamai and the next proof needs a new world; doctor warns when
the checkout has moved on. Start from \`teamai init ${TEAM_URL} --provider git --agent claude\`.

Use the real tool on its cheapest model (claude -p --model haiku). A faked tool proves the fake. A tool that is not
installed or not signed in here makes the claim UNVERIFIABLE, not passed.

Verdicts, reported with the combination and entry point (VERIFIED: claude x git x project scope via teamai pull):
  VERIFIED      every observable matched and the ledger is CLEAN
  FAILED        an observable did not match, or the ledger found a LEAK; quote the output
  UNVERIFIABLE  a prerequisite is missing (a tool, a sign-in, Windows); name it
A fix is proved by a pair: FAILED in a world built from main, VERIFIED in a world built from the change.

Run ledger after the last run, before cleanup. Paste the verdict, the commands, build.json's line from the run's
first output, and the ledger's last line into the PR's real-CLI record.`;

const [verb, ...rest] = process.argv.slice(2);

function doctor(runId: string | undefined): void {
  const line = (good: boolean, text: string): void => console.log(`${good ? 'ok  ' : 'warn'} ${text}`);
  line(true, `node ${process.version}`);
  line(true, git(REPO_ROOT, '--version'));

  for (const tool of TOOL_COMMANDS) {
    try {
      const version = execFileSync(tool, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }).trim().split('\n')[0];
      line(true, `${tool} ${version}`);
    } catch {
      line(false, `${tool} not on PATH: claims about it are UNVERIFIABLE here`);
    }
  }

  if (runId === undefined) return;
  const world = loadWorld(runId);
  const head = git(REPO_ROOT, 'rev-parse', 'HEAD');
  const same = head === world.build.commit && !world.build.dirty && checkoutStatus().length === 0;
  line(world.cleanedAt === undefined, `world ${world.runId} at ${world.dir}${world.cleanedAt === undefined ? '' : ' was cleaned up'}`);
  line(same, `world built from ${world.build.commit.slice(0, 7)}${world.build.dirty ? '+dirty' : ''}; checkout is at ${head.slice(0, 7)}${same ? '' : ': make a new world to test the checkout as it is now'}`);
}

function cleanup(world: World): void {
  const keep = new Set(['world.json', 'logs']);

  for (const name of fs.readdirSync(world.dir)) {
    if (keep.has(name) || /^LEDGER-\d+\.md$/.test(name)) continue;
    fs.rmSync(path.join(world.dir, name), { recursive: true, force: true });
  }

  saveWorld({ ...world, cleanedAt: new Date().toISOString() });
  console.log(`Cleaned ${world.runId}. Evidence kept in ${world.dir}`);
}

function main(): number {
  switch (verb) {
    case 'world': {
      const world = createWorld();
      console.error(`World ${world.dir}\nBuild ${world.build.commit.slice(0, 12)}${world.build.dirty ? '+dirty' : ''}, teamai ${world.build.version}, sha256 ${world.build.sha256.slice(0, 12)}`);
      console.log(world.runId);

      return 0;
    }

    case 'doctor':
      doctor(rest[0]);

      return 0;
    case 'teamai':
      return runInWorld(loadWorld(rest[0]), ['teamai', ...rest.slice(1)]);
    case 'sh':
      if (rest.length < 2) throw new Error('sh needs a run id and a command.');

      return runInWorld(loadWorld(rest[0]), rest.slice(1));
    case 'ledger':
      return runLedger(loadWorld(rest[0])) ? 0 : 1;
    case 'cleanup':
      for (const world of rest[0] === '--all' ? liveWorlds() : [loadWorld(rest[0])]) cleanup(world);

      return 0;
    case 'dir':
      if (rest[0] === '--all') for (const world of liveWorlds()) console.log(`${world.runId} ${world.dir}`);
      else console.log(loadWorld(rest[0]).dir);

      return 0;
    case undefined:
    case 'help':
    case '--help':
      console.log(HELP);

      return 0;
    default:
      console.error(`Unknown verb ${verb}.\n\n${HELP}`);

      return 1;
  }
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
