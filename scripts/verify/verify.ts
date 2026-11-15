import fs from 'node:fs';
import path from 'node:path';
import { helpFor } from './help.js';
import { runLedger } from './ledger.js';
import { planCleanup, removeLeftover } from './leftovers.js';
import { passedKeys, splitPassOption } from './secrets.js';
import { addMember, ensureOrigin, memberLayout, parseMachine, removeMachines } from './members.js';
import { memberOf, parseTarget, runOn } from './target.js';
import { checkoutStatus, createWorld, git, liveWorlds, loadWorld, REPO_ROOT, tmpDirsOutside, TOOL_COMMANDS, updateWorld, type World } from './world.js';

const [verb, ...rest] = process.argv.slice(2);

async function doctor(runId: string | undefined): Promise<void> {
  const { probeHostCommand } = await import('./doctor.js');
  const line = (good: boolean, text: string): void => console.log(`${good ? 'ok  ' : 'warn'} ${text}`);
  line(true, `node ${process.version}`);
  line(true, git(REPO_ROOT, '--version'));

  // The tool a world's commands run: the member's own, as the world's `tools` links it.
  for (const tool of TOOL_COMMANDS) {
    const version = probeHostCommand([tool, '--version'], { timeoutMs: 15_000 });

    if (version.ok) line(true, `${tool} ${version.first}`);
    else line(false, version.why === 'not installed' ? `${tool} not on PATH: claims about it are UNVERIFIABLE here` : `${tool}: ${version.why}: claims about it are UNVERIFIABLE here`);
  }

  if (runId === undefined) return;
  const world = loadWorld(runId);
  const head = git(REPO_ROOT, 'rev-parse', 'HEAD');
  const same = head === world.build.commit && !world.build.dirty && checkoutStatus().length === 0;
  line(world.cleanedAt === undefined, `world ${world.runId} at ${world.dir}${world.cleanedAt === undefined ? '' : ' was cleaned up'}`);
  line(same, `world built from ${world.build.commit.slice(0, 7)}${world.build.dirty ? '+dirty' : ''}; checkout is at ${head.slice(0, 7)}${same ? '' : ': make a new world to test the checkout as it is now'}`);
}

/**
 * Removes what the world's runs left that the leftover rows attribute to it, then the world's files, keeping world.json,
 * logs/, observed.jsonl and every ledger. Never signals a process or closes a place: while one of the world's lives or
 * stays open, or the check for one could not run, refuses and says why.
 */
async function cleanup(world: World): Promise<boolean> {
  const plan = await planCleanup(world);

  if (plan.kind === 'refuse') {
    for (const { why, items } of plan.refusals) console.error(`Not cleaning ${world.runId}: ${why}:\n${items.map((item) => `  ${item}`).join('\n')}`);

    return false;
  }

  for (const note of plan.unobserved) console.error(`NOT OBSERVED: ${note}; cleanup removed nothing of it.`);

  for (const removal of plan.removals) {
    const removed = removeLeftover(removal);

    if (!removed.ok) {
      console.error(`Not cleaning ${world.runId}: removing ${removal.what} failed (${removed.why}). Its files are kept, so a ledger can still find it.`);

      return false;
    }

    console.log(removed.wasThere ? `Removed ${removal.what}` : `Already gone: ${removal.what}`);
  }

  const machines = removeMachines(world);

  if (!machines.ok) {
    console.error(`Not cleaning ${world.runId}: ${machines.why}.`);

    return false;
  }

  for (const name of machines.removed) console.log(`Removed the harness's container ${name}`);

  const keep = new Set(['world.json', 'logs', 'observed.jsonl']);

  for (const name of fs.readdirSync(world.dir)) {
    if (keep.has(name) || /^LEDGER-\d+\.md$/.test(name)) continue;
    fs.rmSync(path.join(world.dir, name), { recursive: true, force: true });
  }

  // A world made since its TMPDIR moved out of its directory, to /tmp; each member's sits beside it. loadWorld vouched for each.
  for (const { tmp } of tmpDirsOutside(world)) fs.rmSync(tmp, { recursive: true, force: true });

  updateWorld(world, (fresh) => ({ ...fresh, cleanedAt: new Date().toISOString() }));
  console.log(`Cleaned ${world.runId}. Evidence kept in ${world.dir}`);

  return true;
}

async function main(): Promise<number> {
  switch (verb) {
    case 'world': {
      const world = await createWorld();
      console.error(`World ${world.dir}\nBuild ${world.build.commit.slice(0, 12)}${world.build.dirty ? '+dirty' : ''}, teamai ${world.build.version}, sha256 ${world.build.sha256.slice(0, 12)}`);
      console.log(world.runId);

      return 0;
    }

    case 'doctor': {
      const run = rest.find((arg) => arg !== '--drivers');
      await doctor(run === undefined ? undefined : parseTarget(run).runId);

      if (rest.includes('--drivers')) {
        const { doctorDrivers } = await import('./doctor.js');
        const world = run === undefined ? undefined : loadWorld(parseTarget(run).runId);
        await doctorDrivers((good, text) => console.log(`${good ? 'ok  ' : 'warn'} ${text}`), world !== undefined && world.cleanedAt === undefined ? { world } : {});
      }

      return 0;
    }

    case 'origin': {
      const world = ensureOrigin(loadWorld(parseTarget(rest[0]).runId));
      console.log(`${world.origin?.url ?? ''} -> ${world.origin?.bare ?? ''}`);

      return 0;
    }

    case 'member': {
      const [run, name, ...flags] = rest;

      if (name === undefined) throw new Error('member needs a run id and a name, such as `member <run> bob`.');
      const world = addMember(loadWorld(parseTarget(run).runId), { name, machine: parseMachine(flags) });
      console.log(memberOf(world, name).project);

      return 0;
    }

    case 'teamai':
    case 'sh': {
      const { runId, target } = parseTarget(rest[0]);
      const { names, argv: command } = splitPassOption(rest.slice(1));
      const passed = passedKeys(names, process.env);

      if (!passed.ok) throw new Error(`--pass names ${passed.missing.join(', ')}, which this shell does not set to a value. Export each one first, or leave it out.`);

      if (verb === 'sh' && command.length === 0) throw new Error('sh needs a run id and a command.');
      const argv = verb === 'teamai' ? ['teamai', ...command] : command;

      return (await runOn(loadWorld(runId), target, argv, { pass: passed.keys })).exit;
    }

    // The ledger and cleanup cover the world and every member of it, whichever one names it.
    case 'ledger':
      return (await runLedger(loadWorld(parseTarget(rest[0]).runId))).leaks === 0 ? 0 : 1;
    case 'cleanup': {
      const { worlds, skipped } = rest[0] === '--all' ? liveWorlds() : { worlds: [loadWorld(parseTarget(rest[0]).runId)], skipped: [] };
      let isClean = skipped.length === 0;

      for (const { name, why } of skipped) console.error(`Skipped ${name}: ${why}`);

      for (const world of worlds) isClean = await cleanup(world) && isClean;

      return isClean ? 0 : 1;
    }

    case 'reap': {
      const { reap } = await import('./reap.js');

      return reap(rest, loadWorld);
    }

    case 'dir': {
      if (rest[0] === '--all') {
        const { worlds, skipped } = liveWorlds();

        for (const { name, why } of skipped) console.error(`Skipped ${name}: ${why}`);

        for (const world of worlds) console.log(`${world.runId} ${world.dir}`);

        return skipped.length === 0 ? 0 : 1;
      }

      const { runId, target } = parseTarget(rest[0]);
      const world = loadWorld(runId);
      console.log(target.kind === 'member' ? memberLayout(world, { name: memberOf(world, target.name).name, tmpRoot: '' }).root : world.dir);

      return 0;
    }

    case undefined:
    case 'help':
    case '--help':
      console.log(helpFor(rest[0]));

      return 0;
    default:
      console.error(`Unknown verb ${verb}.\n\n${helpFor(undefined)}`);

      return 1;
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
