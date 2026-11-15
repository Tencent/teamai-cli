import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readRegularFileSync } from '@teamai/shared/regular-file';
import { PROVIDER_COMMANDS } from '../provider-commands.js';
import { OS_RELEASE } from '../this-machine.js';
import { isWithin, onPath, type NativeSandbox, type Sandboxed } from './native.js';

// ─── bwrap: Linux namespaces, through bubblewrap ───
//
//  Each exec runs in a new user, PID, IPC and UTS namespace on an empty root that holds only what is bound into it:
//
//    bwrap --die-with-parent [--new-session] --unshare-all --share-net
//          --ro-bind-try /usr /usr … /etc /etc  --proc /proc --dev /dev --tmpfs /tmp
//          --bind <path> <path> …               the place, the step's own home and temp directory, and each folder
//                                               between a git path and the place that holds it, so it stays put
//          --ro-bind <path> <path> …            the view's git paths, this machine's PATH directories and install roots
//          --chdir <cwd> -- <argv>
//
//  Every path keeps its host path, binds made shallowest first so a deeper one wins. The member's home and other
//  repositories are not bound, so they do not exist inside. No value goes into the argv: the step's environment is the
//  process's own, which bwrap passes on. The step dies with the runtime process that started it: through the watch pipe
//  native.ts launches every exec with, and --die-with-parent.
//
//  --new-session keeps a step from typing into a terminal it was started on (TIOCSTI). An exec starts detached, on no
//  terminal, and goes without it: bwrap's init calls setsid before it binds its life to bwrap's, so an exec's watcher,
//  which kills the exec's process group, would miss a step killed in its first milliseconds, and that step would run on.
//  --share-net keeps this machine's network namespace, its loopback and abstract sockets included, and bwrap filters
//  none of it, so a step reaches every port of this machine: it is at `isolation: worktree`, never unattended, and never
//  the outer of an app's runtime.
//

/** The system directories every process needs, read only: whichever of them this distribution has. */
const SYSTEM = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/etc'];

const OPTIONS = ['--die-with-parent', '--unshare-all', '--share-net'];

/** The command that installs bubblewrap, by the os-release IDs of the distributions that use it (sandcastle's). */
const INSTALL = [
  { ids: ['debian', 'ubuntu'], command: 'sudo apt install bubblewrap' },
  { ids: ['fedora', 'rhel', 'centos', 'rocky', 'almalinux', 'amzn'], command: 'sudo dnf install bubblewrap' },
  { ids: ['arch', 'manjaro', 'endeavouros'], command: 'sudo pacman -S bubblewrap' },
  { ids: ['alpine'], command: 'sudo apk add bubblewrap' },
  { ids: ['opensuse', 'suse', 'sles', 'opensuse-leap', 'opensuse-tumbleweed'], command: 'sudo zypper install bubblewrap' },
];

/** This distribution's os-release IDs: its `ID`, then each it is like (`ID_LIKE`). */
function distributionIds(): string[] {
  const file = OS_RELEASE.find((at) => fs.existsSync(at));
  const text = file === undefined ? '' : readRegularFileSync(file, 'utf8');
  const field = (name: string): string => (new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1] ?? '').replaceAll(/["']/g, '').trim();

  return [field('ID'), ...field('ID_LIKE').split(/\s+/)].flatMap((id) => (id === '' ? [] : [id.toLowerCase()]));
}

/** Why bwrap is missing, with the one command that installs it here, or each command when this distribution is not known. */
function notInstalled(): string {
  const command = distributionIds().map((id) => INSTALL.find(({ ids }) => ids.includes(id))?.command).find((found) => found !== undefined);
  const how = command === undefined ? `Install bubblewrap with your distribution's package manager (${INSTALL.map((install) => `\`${install.command}\``).join(', ')})` : `Install it with \`${command}\``;

  return `bwrap is not installed here, or not on PATH. ${how}, and start again. On macOS, use provider: seatbelt`;
}

/**
 * Each folder between a git path and the writable path that holds it, bound onto itself: a mount point cannot be
 * renamed or removed, so no step moves a git path aside by moving a folder above it (sandcastle's `anchorArgs`).
 */
function anchorsOf({ writable, gitPaths }: { writable: string[]; gitPaths: string[] }): string[] {
  const anchors = new Set<string>();

  for (const at of gitPaths) {
    for (let dir = path.dirname(at); writable.some((root) => dir !== root && isWithin(dir, root)); dir = path.dirname(dir)) anchors.add(dir);
  }

  return [...anchors];
}

/** bwrap's arguments for `sandboxed`, the command last. */
export function argsOf({ argv, cwd, writable, readable, gitPaths, isDetached }: Pick<Sandboxed, 'argv' | 'cwd' | 'writable' | 'readable' | 'gitPaths' | 'isDetached'>): string[] {
  const binds = [...[...writable, ...anchorsOf({ writable, gitPaths })].map((at) => ({ at, flag: '--bind' })), ...readable.map((at) => ({ at, flag: '--ro-bind-try' }))]
    .sort((left, right) => left.at.split(path.sep).length - right.at.split(path.sep).length);

  return [
    ...OPTIONS,
    ...(isDetached ? [] : ['--new-session']),
    ...SYSTEM.flatMap((at) => ['--ro-bind-try', at, at]),
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    ...binds.flatMap(({ at, flag }) => [flag, at, at]),
    '--chdir', cwd, '--', ...argv,
  ];
}

export const bwrap: NativeSandbox = {
  provider: 'bwrap',
  isolation: 'worktree',
  isUnattended: false,

  async preflight(env) {
    const executable = onPath(PROVIDER_COMMANDS.bwrap, env.PATH);

    if (executable === undefined) return { ok: false, message: notInstalled() };

    // The options every sandbox takes, on the host's root: what AppArmor or a kernel without user namespaces refuses.
    const refused = await new Promise<string | undefined>((resolve) => {
      execFile(executable, [...OPTIONS, '--new-session', '--ro-bind', '/', '/', 'true'], { env, timeout: 10_000 }, (error, _stdout, stderr) => {
        resolve(error ? String(stderr).trim().split('\n').at(-1) || error.message : undefined);
      });
    });

    if (refused === undefined) return { ok: true };

    return {
      ok: false,
      message: `bwrap could not create a sandbox: ${refused}. On Ubuntu 24.04 or later, AppArmor keeps unprivileged programs from creating user namespaces: allow bwrap with an AppArmor profile (\`sudo apt install apparmor-profiles\`, then \`sudo ln -s /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/ && sudo systemctl reload apparmor\`), or turn the restriction off with \`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\`. Elsewhere, check that user namespaces are enabled (\`sysctl kernel.unprivileged_userns_clone\`). Then start again`,
    };
  },

  wrap: (sandboxed) => ({ command: PROVIDER_COMMANDS.bwrap, args: argsOf(sandboxed) }),
};
