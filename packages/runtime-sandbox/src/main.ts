import fs from 'node:fs';
import path from 'node:path';
import { WRAPPER_PREFIX } from '@teamai/runtime-kit/outer';
import { isStartedByTeamai } from '@teamai/runtime-kit/serve';
import { getUserHome } from '@teamai/shared/home';
import { signalPid } from '@teamai/shared/process-group';
import { journal } from './journal.js';
import { sandboxJournalRoot } from './journal-root.js';
import type { RuntimeMessage } from '@teamai/runtime-protocol';
import type { ParsedOptions } from './options.js';
import { unreachable, type Provider } from './provider.js';
import { bwrap } from './providers/bwrap.js';
import { containerProvider, removeWarmImages, warmImagesSaved } from './providers/container.js';
import { nativeProvider } from './providers/native.js';
import { removeWarmTemplates, sbxProvider, warmTemplatesSaved } from './providers/sbx.js';
import { seatbelt } from './providers/seatbelt.js';
import { vercelProvider } from './providers/vercel.js';
import { serve } from './runtime.js';
import { PLATFORM } from './this-machine.js';
import { toolExec } from './wrapper.js';

// teamai-runtime-sandbox: teamai spawns it for a driver definition that uses runtime `sandbox`, and speaks runtime
// protocol 1 to it over stdio. Its stdout carries only protocol lines; anything for a person goes to stderr.

// When teamai is gone, a line it would have read goes nowhere: an exec still running keeps going and records its end.
// So does a warning on stderr, which a sweep nothing waits for can write at any time.
let stdoutOpen = true;
let stderrOpen = true;

process.stdout.on('error', () => { stdoutOpen = false; });

process.stderr.on('error', () => { stderrOpen = false; });

const uid = process.getuid?.();
const gid = process.getgid?.();
const journalRoot = sandboxJournalRoot(getUserHome());
const sandboxJournal = journal(journalRoot);

/**
 * Why nothing of the sandbox runs on Windows: a sandbox mounts each path of the attempt at that same path, and a Linux
 * sandbox has no `C:\\` path; an app reaches the attempt over a Unix socket, through a link named after the tool.
 */
const NOT_ON_WINDOWS = 'A sandbox mounts each path of the attempt at that same path, which a Windows path cannot be in a Linux sandbox, and teamai-sandbox-<tool> finds its tool by the name of a link, which an npm shim on Windows does not keep.';

// Called as `teamai-sandbox-<tool>` (a `bin` of teamai-cli, or a link named after an instance), or as
// `teamai-runtime-sandbox tool-exec <tool> …`, it is the sandbox wrapper an app runs in place of a tool (wrapper.ts).
const calledAs = path.basename(process.argv[1] ?? '');
const [mode, wrapped] = process.argv.slice(2);

const wrapper = calledAs.startsWith(WRAPPER_PREFIX)
  ? { name: calledAs.slice(WRAPPER_PREFIX.length), args: process.argv.slice(2) }
  : mode === 'tool-exec' && wrapped !== undefined ? { name: wrapped, args: process.argv.slice(4) } : undefined;

if (wrapper === undefined && mode === 'remove-warm' && wrapped === '--dry-run') {
  // An uninstall's preview: each warm image and template this journal's providers saved, a line each, asking no engine.
  const saved = PLATFORM === 'win32' ? [] : [
    ...warmImagesSaved({ engine: 'docker', state: path.join(journalRoot, 'docker') }),
    ...warmImagesSaved({ engine: 'podman', state: path.join(journalRoot, 'podman') }),
    ...warmTemplatesSaved({ state: path.join(journalRoot, 'sbx') }),
  ];

  for (const line of saved) process.stdout.write(`${line}\n`);
} else if (wrapper === undefined && mode === 'remove-warm') {
  // `teamai uninstall` runs it in the member's HOME: each warm image and template this journal's providers saved is
  // removed, a line on stdout each, and one that stays is named on stderr with how to remove it. Windows runs none.
  const removals = PLATFORM === 'win32' ? [] : await Promise.all([
    removeWarmImages({ engine: 'docker', state: path.join(journalRoot, 'docker'), env: process.env }),
    removeWarmImages({ engine: 'podman', state: path.join(journalRoot, 'podman'), env: process.env }),
    removeWarmTemplates({ state: path.join(journalRoot, 'sbx'), env: process.env }),
  ]);

  for (const { removed, left } of removals) {
    for (const line of removed) process.stdout.write(`${line}\n`);

    for (const line of left) process.stderr.write(`${line}\n`);
  }
} else if (PLATFORM === 'win32' && (wrapper !== undefined || !isStartedByTeamai(process.env))) {
  // An app starts the wrapper through an npm .cmd shim that keeps no name of its own, with the tool's arguments or
  // none, so anything teamai did not start here is an app's.
  process.stderr.write(`teamai-sandbox${wrapper === undefined ? '' : `-${wrapper.name}`} (sandbox_unavailable): it does not run on Windows. ${NOT_ON_WINDOWS} Run the app and teamai inside WSL2, or give the app the plain tool.\n`);
  // No exit: on Windows a write to a pipe is asynchronous, and the message must reach the app.
  process.exitCode = 2;
} else if (wrapper === undefined) {
  // An exec still running when teamai closes stdin keeps the process alive, and records its end: no exit here.
  process.exitCode = await serve({
    write: (message: RuntimeMessage) => {
      if (stdoutOpen) process.stdout.write(`${JSON.stringify(message)}\n`);
    },
    journal: sandboxJournal,
    warn: (line) => {
      if (stderrOpen) process.stderr.write(`${line}\n`);
    },
    provider: providerOf,
    env: process.env,
  });
} else {
  const end = await toolExec({ ...wrapper, env: process.env, cwd: process.cwd(), journal: sandboxJournal });

  if ('signal' in end) signalPid(process.pid, end.signal);
  else process.exit(end.code);
}

function providerOf(options: ParsedOptions): Provider {
  if (PLATFORM === 'win32') {
    return unreachable({ code: 'sandbox_unavailable', message: `The sandbox runtime does not run on Windows. ${NOT_ON_WINDOWS} Run teamai inside WSL2 (\`wsl --install\`, then install teamai there), or run the steps with --driver local` }, options.provider === 'vercel' ? 'copy' : 'bind');
  }

  switch (options.provider) {
    case 'sbx':
      return sbxProvider({ agent: options.agent, owner: sandboxJournal.owner, env: process.env, warm: options.warm, ...(options.profile && { profile: options.profile }), state: path.join(journalRoot, 'sbx') });
    case 'docker':
    case 'podman':
      return containerProvider({
        engine: options.provider,
        image: options.image,
        warm: options.warm,
        ...(options.profile && { profile: options.profile }),
        owner: sandboxJournal.owner,
        state: path.join(journalRoot, options.provider),
        host: { user: uid !== undefined && gid !== undefined ? { uid, gid } : undefined, selinux: fs.existsSync('/sys/fs/selinux/enforce'), env: process.env },
      });
    case 'seatbelt':
      return nativeProvider({ sandbox: seatbelt, state: path.join(journalRoot, 'seatbelt'), env: process.env, home: getUserHome() });
    case 'bwrap':
      return nativeProvider({ sandbox: bwrap, state: path.join(journalRoot, 'bwrap'), env: process.env, home: getUserHome() });
    case 'vercel':
      return vercelProvider({ options, owner: sandboxJournal.owner, state: path.join(journalRoot, 'vercel'), env: process.env, home: getUserHome() });
    default: {
      const unhandled: never = options;

      return unhandled;
    }
  }
}
