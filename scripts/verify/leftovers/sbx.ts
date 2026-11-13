/**
 * sbx sandboxes teamai named (`teamai-<journal>-…`), tied to a world by the owner journal of one of its HOMEs, and the warm
 * templates teamai saved (`teamai-warm:<key>`) with the kit templates sbx assembled for its sandboxes
 * (`sandbox-kit-assembled:<hash>`, sbx's own, which teamai uninstall leaves), tied to a world by the HOME sbx was asked in,
 * whose image store holds them: a world's scratch HOME holds only what the world made. sbx keeps sandboxes and templates
 * per HOME, so each install on this machine is asked in its own, with its own environment, as teamai asks; a world made
 * before its environment was kept is asked in the harness's HOME, which is no world's. Templates are asked for only when
 * the install's PATH runs the very file the host's sbx is: a shim in its place, such as one that runs sbx in the person's
 * HOME to reach their sign-in, makes sbx answer from a HOME that is not the install's, whose templates are not the world's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROVIDER_COMMANDS } from '../../../packages/runtime-sandbox/src/provider-commands.js';
import { journalOfSandboxName } from '../../../packages/runtime-sandbox/src/provider.js';
import { sbxKitTemplatesListed, sbxNamesListed, sbxWarmTemplatesListed } from '../../../packages/runtime-sandbox/src/providers/sbx.js';
import { attributeLeftover, type LeftoverContext, type LeftoverKind, type Observed } from '../leftovers.js';
import { captureOn, hostInstalls } from '../target.js';
import { hostCommand } from '../world.js';

const command = PROVIDER_COMMANDS.sbx;

type Install = ReturnType<typeof hostInstalls>[number];

/** The sandboxes `sbx ls --json` lists in the install's HOME, or that it could not list them. */
function sandboxesOn({ self, others }: LeftoverContext, { commandLine }: Install, listed: ReturnType<typeof captureOn>, of: string): Observed {
  const names = listed.code === 0 ? sbxNamesListed(listed.stdout) : undefined;

  if (names === undefined) return { kind: 'not_observed', what: `sbx sandboxes${of}`, why: `\`sbx ls --json\` failed or printed no list: ${listed.why}` };

  return {
    kind: 'observed',
    findings: names.flatMap((name) => {
      const journal = journalOfSandboxName(name);

      return journal === undefined ? [] : [{ what: `sbx sandbox ${name}`, attribution: attributeLeftover({ paths: [], journals: [journal], runs: [], marked: true }, self, others), remove: commandLine([command, 'rm', '--force', name]) }];
    }),
    notes: [],
  };
}

/** sbx 0.53.0's answer to a `template rm` of a template that is gone. */
const GONE = /image not found/i;

/** The real file a search of `PATH` runs sbx as, as a spawn with that PATH finds it, or undefined when no directory holds it. */
function realSbxOn(PATH: string): string | undefined {
  for (const dir of PATH.split(':').filter((each) => each !== '')) {
    const at = path.join(dir, command);

    // A directory without it, or with a file it cannot run, is passed over, as the spawn's own search passes it over.
    try {
      fs.accessSync(at, fs.constants.X_OK);

      if (fs.statSync(at).isFile()) return fs.realpathSync.native(at);
    } catch {
      continue;
    }
  }

  return undefined;
}

/**
 * Why sbx may answer the install from a HOME that is not the install's, or undefined when its PATH runs the very file the
 * host's sbx is, which a world links into its `tools`: that file is then started with the install's own environment, and
 * so reads its HOME. Compared as real files, so any shim in its place, whatever folder of the PATH holds it, answers why.
 */
function whySbxMayAnswerFromAnotherHome({ env }: Install): string | undefined {
  const installs = realSbxOn(env.PATH ?? '');
  let host: string | undefined;

  try {
    const found = hostCommand(command);
    host = found === undefined ? undefined : fs.realpathSync.native(found);
  } catch (error) {
    return `the host's sbx, to compare the install's with, could not be found: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (installs === undefined) return "the install's PATH runs no sbx";

  if (host === undefined) return `the host has no sbx on PATH to compare the install's ${installs} with, so sbx may answer from a HOME that is not the install's`;

  return installs === host ? undefined : `the install's PATH runs sbx as ${installs}, not as ${host}, the host's sbx a world links, so sbx may answer from a HOME that is not the install's (a shim that runs it with another HOME, say)`;
}

/** teamai's warm templates, and sbx's kit templates, `sbx template ls --json` lists in the HOME the install's environment names, or that it could not list them. */
function templatesOn({ world, self, others }: LeftoverContext, install: Install, of: string): Observed {
  const { target, env, commandLine } = install;
  const elsewhere = whySbxMayAnswerFromAnotherHome(install);

  // Neither kind carries the world's HOME in its name: asked from another HOME, the person's own would read as the world's.
  if (elsewhere !== undefined) return { kind: 'not_observed', what: `sbx templates${of}`, why: elsewhere };

  const listed = captureOn(world, target, [command, 'template', 'ls', '--json']);
  const saved = listed.code === 0 ? sbxWarmTemplatesListed(listed.stdout) : undefined;
  const kits = listed.code === 0 ? sbxKitTemplatesListed(listed.stdout) ?? [] : [];

  if (saved === undefined) return { kind: 'not_observed', what: `sbx templates${of}`, why: `\`sbx template ls --json\` failed or printed no list: ${listed.why}` };

  return {
    kind: 'observed',
    // A kit template carries no mark of teamai's: one in no world's HOME is sbx's, never counted.
    findings: [...saved.map(({ ref }) => ({ ref, what: `sbx template ${ref}`, isMarked: true })), ...kits.map(({ ref }) => ({ ref, what: `sbx template ${ref} (sbx's own, which teamai uninstall leaves)`, isMarked: false }))].map(({ ref, what, isMarked }) => ({
      what,
      attribution: attributeLeftover({ paths: env.HOME === undefined ? [] : [env.HOME], journals: [], runs: [], marked: isMarked }, self, others),
      remove: commandLine([command, 'template', 'rm', '--force', ref]),
      gone: GONE,
    })),
    notes: [],
  };
}

export const sbxLeftovers: LeftoverKind = {
  title: 'teamai sbx sandbox or template',
  onCleanup: { kind: 'remove' },
  observe(context) {
    return Promise.resolve(hostInstalls(context.world).flatMap((install): Observed[] => {
      const listed = captureOn(context.world, install.target, [command, 'ls', '--json']);
      const of = install.at === context.world.runId ? '' : ` of ${install.at}`;

      if (listed.errno === 'ENOENT') return [{ kind: 'observed', findings: [], notes: [`sbx sandboxes and templates${of}: sbx not installed here`] }];

      // Sandboxes go first: cleanup removes in this order, so no sandbox of the world still runs from a template it removes.
      return [sandboxesOn(context, install, listed, of), templatesOn(context, install, of)];
    }));
  },
};
