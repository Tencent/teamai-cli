import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isWithin, onPath, type NativeSandbox, type Sandboxed } from './native.js';
import { PROVIDER_COMMANDS } from '../provider-commands.js';
import { SYSTEM_BIN } from '../this-machine.js';

// ─── seatbelt: macOS's own sandbox, through sandbox-exec ───
//
//  Each exec runs `sandbox-exec -p <profile> -D NAME=<path> … <argv>`. The profile denies everything it does not allow
//  (after OpenAI Codex's base policy, as sandcastle's `seatbeltProfile.ts` adapts it):
//
//    (deny default)                                  nothing but what follows
//    processes                                       fork and exec; signals and process information only for
//                                                    processes in this sandbox; a list of sysctls (no process
//                                                    list) and of Mach services (directory, logging, trust, DNS)
//    files                                           any path's metadata; the system directories, this Mac's
//                                                    developer directory, the view's git paths and the PATH's tools,
//                                                    read only; the place (worktree, result, run directory, tool
//                                                    homes, the step's own home and temp directory), read and written
//    network                                         as on the host, except this Mac itself: none of its ports
//                                                    (loopback, and its own addresses) but the ones the
//                                                    attempt's credentials name; and Unix sockets only in the
//                                                    place, and the DNS resolver's
//    never, whatever comes before                    a container engine's socket or state (Docker, Colima, OrbStack,
//                                                    Lima, Rancher Desktop); a write to a git path inside the place,
//                                                    or a rename or removal of a folder that holds one
//
//  A later rule wins over an earlier one. A path goes in as a `-D` parameter, never into the profile's text, so no path
//  can change the profile. A step here is at `isolation: worktree`: it has no PID namespace and keeps this Mac's network,
//  this Mac's own ports aside. macOS's `localhost` in a network rule covers every address of this Mac, its LAN address
//  included, so a server the step starts itself is out of its reach too.
//

const SANDBOX_EXEC = PROVIDER_COMMANDS.seatbelt;
const SW_VERS = path.join(SYSTEM_BIN, 'sw_vers');

const NOT_MACOS = `seatbelt runs only on macOS 14 or later, and this machine has no ${SW_VERS}. On Linux, use provider: bwrap; anywhere, provider: sbx or docker`;

/** What `file` printed on stdout, or why it could not run. */
function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: true; stdout: string } | { ok: false; message: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: 10_000 }, (error, stdout, stderr) => {
      resolve(error ? { ok: false, message: String(stderr).trim().split('\n').at(-1) || error.message } : { ok: true, stdout: String(stdout) });
    });
  });
}

/** The system directories every step reads: the toolchain, Homebrew and `/opt`, and what `/bin/sh` and the resolver read. */
const SYSTEM = ['/bin', '/sbin', '/usr', '/System', '/Library', '/opt', '/private/etc', '/private/var/db', '/private/var/select'];

/** Where `xcode-select` points: the developer directory `/usr/bin/git` and its siblings run from. */
const XCODE_SELECT_LINK = '/var/db/xcode_select_link';

/** A container engine's sockets and state, under the member's home and in `/var/run`: a way into the engine is a way out. */
const ENGINE_HOME = ['.docker', '.colima', '.orbstack', '.lima', '.rd'];
const ENGINE_SOCKETS = ['/private/var/run/docker.sock', '/private/var/run/com.docker.vmnetd.sock'];

/** The DNS resolver's socket, which name lookups reach. */
const RESOLVER = '/private/var/run/mDNSResponder';

/** Deny-default, processes, sysctls and system services (Codex's base policy, as sandcastle's `seatbeltProfile.ts` holds it). */
const BASE = String.raw`(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow sysctl-read
  (sysctl-name "hw.activecpu") (sysctl-name "hw.busfrequency_compat") (sysctl-name "hw.byteorder") (sysctl-name "hw.cacheconfig")
  (sysctl-name "hw.cachelinesize_compat") (sysctl-name "hw.cpufamily") (sysctl-name "hw.cpufrequency_compat") (sysctl-name "hw.cputype")
  (sysctl-name "hw.l1dcachesize_compat") (sysctl-name "hw.l1icachesize_compat") (sysctl-name "hw.l2cachesize_compat")
  (sysctl-name "hw.l3cachesize_compat") (sysctl-name "hw.logicalcpu_max") (sysctl-name "hw.machine") (sysctl-name "hw.model")
  (sysctl-name "hw.memsize") (sysctl-name "hw.ncpu") (sysctl-name "hw.nperflevels") (sysctl-name-prefix "hw.optional.arm.")
  (sysctl-name-prefix "hw.optional.armv8_") (sysctl-name "hw.packages") (sysctl-name "hw.pagesize_compat") (sysctl-name "hw.pagesize")
  (sysctl-name "hw.physicalcpu") (sysctl-name "hw.physicalcpu_max") (sysctl-name "hw.logicalcpu") (sysctl-name "hw.cpufrequency")
  (sysctl-name "hw.tbfrequency_compat") (sysctl-name "hw.vectorunit") (sysctl-name "machdep.cpu.brand_string") (sysctl-name "kern.argmax")
  (sysctl-name "kern.hostname") (sysctl-name "kern.maxfilesperproc") (sysctl-name "kern.maxproc") (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.osrelease") (sysctl-name "kern.ostype") (sysctl-name "kern.osvariant_status") (sysctl-name "kern.osversion")
  (sysctl-name "kern.secure_kernel") (sysctl-name "kern.sysv.semmns") (sysctl-name "kern.usrstack64") (sysctl-name "kern.version")
  (sysctl-name "sysctl.proc_cputype") (sysctl-name "vm.loadavg") (sysctl-name-prefix "hw.perflevel") (sysctl-name-prefix "kern.proc.pgrp.")
  (sysctl-name-prefix "kern.proc.pid.") (sysctl-name-prefix "net.routetable."))
(allow sysctl-write (sysctl-name "kern.grade_cputype"))
(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))
(allow ipc-posix-sem)
(allow ipc-posix-shm-read* (ipc-posix-name "apple.shm.notification_center"))
(allow system-mac-syscall (mac-policy-name "vnguard"))
(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))
(allow system-fsctl (fsctl-command FSIOC_CAS_BSDFLAGS))
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.system.DirectoryService.libinfo_v1") (global-name "com.apple.system.logger")
  (global-name "com.apple.system.notification_center") (global-name "com.apple.bsd.dirhelper") (global-name "com.apple.logd")
  (global-name "com.apple.diagnosticd") (global-name "com.apple.secinitd") (global-name "com.apple.trustd")
  (global-name "com.apple.trustd.agent") (global-name "com.apple.SecurityServer") (global-name "com.apple.networkd")
  (global-name "com.apple.ocspd") (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.PowerManagement.control"))
(allow file-read-metadata)
(allow file-read* (literal "/"))
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl
  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/ptmx") (literal "/dev/dtracehelper") (regex #"^/dev/ttys[0-9]+$"))
(allow file-read* (literal "/dev/random") (literal "/dev/urandom"))
(allow file-read-data file-write-data (subpath "/dev/fd"))
(allow network*)
(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))
(deny network-outbound (remote unix-socket))`;

/**
 * What this Mac's developer tools read: the directory `xcode-select` points to (in Xcode, the whole app, whose
 * `SharedFrameworks` its tools load), and the member's xcrun cache, read only. Without the cache each `/usr/bin/git`
 * runs xcodebuild to find itself, four seconds a call; with it, xcrun still prints that it cannot write the cache.
 */
function developerPaths(): string[] {
  const paths: string[] = [];

  try {
    const developer = fs.realpathSync(XCODE_SELECT_LINK);
    paths.push(developer.endsWith('.app/Contents/Developer') ? path.dirname(path.dirname(developer)) : developer);
  } catch {
    // No developer tools.
  }

  try {
    paths.push(path.join(fs.realpathSync(execFileSync(path.join(SYSTEM_BIN, 'getconf'), ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', timeout: 5_000 }).trim()), 'xcrun_db'));
  } catch {
    // Not macOS, or no temp directory of the member's.
  }

  return paths;
}

/** A profile's text, and the `-D` parameters (`NAME=<path>`) it reads its paths from. */
export interface SeatbeltProfile {
  profile: string;
  params: string[];
}

/**
 * The folders a step may not rename or remove: each writable root, and each folder between a read-only path inside a
 * writable root and that root, so a git file cannot be moved aside and planted again (sandcastle's `anchoredDirs`).
 */
function anchoredOf({ writable, locked }: { writable: string[]; locked: string[] }): string[] {
  const anchored = new Set(writable);

  for (const at of locked) {
    for (let dir = path.dirname(at); writable.some((root) => isWithin(dir, root)); dir = path.dirname(dir)) {
      anchored.add(dir);

      if (path.dirname(dir) === dir) break;
    }
  }

  return [...anchored];
}

/** The profile a step runs under. `memberHome` is the member's home, whose container engines no step reaches. */
export function profileOf({ writable, readable, gitPaths, memberHome, hostPorts }: Pick<Sandboxed, 'writable' | 'readable' | 'gitPaths' | 'memberHome' | 'hostPorts'>): SeatbeltProfile {
  const params: string[] = [];
  let count = 0;

  const param = (prefix: string, at: string): string => {
    const name = `${prefix}${count}`;
    count += 1;
    params.push(`${name}=${at}`);

    return `(param "${name}")`;
  };

  const filters = (kind: 'subpath' | 'literal', prefix: string, paths: string[]): string => paths.map((at) => `(${kind} ${param(prefix, at)})`).join(' ');

  // A read-only path inside a writable one (the worktree's .git) stays read-only, and the folders holding a git path stay put.
  const locked = readable.filter((at) => writable.some((place) => isWithin(at, place)));
  const readRoots = [...new Set([...SYSTEM, ...developerPaths(), ...readable])];

  const lines = [
    BASE,
    // A daemon of the member's on this Mac, such as Paseo's, may run what any local client asks, outside the sandbox.
    '(deny network-outbound (remote ip "localhost:*"))',
    ...hostPorts.map((port) => `(allow network-outbound (remote ip "localhost:${port}"))`),
    `(allow network-outbound (remote unix-socket (path-literal ${param('RESOLVER', RESOLVER)})))`,
    `(allow file-read* file-map-executable ${filters('subpath', 'READ', readRoots)})`,
    `(allow file-read* file-write* file-map-executable ${filters('subpath', 'WRITE', writable)})`,
    ...writable.map((at) => `(allow network-outbound (remote unix-socket (subpath ${param('SOCKET', at)})))`),
    `(deny file-read* file-write* network-outbound process-exec ${filters('literal', 'ENGINE', ENGINE_SOCKETS)} ${filters('subpath', 'ENGINE', ENGINE_HOME.map((name) => path.join(memberHome, name)))})`,
    '(deny mach-lookup (xpc-service-name-prefix ""))',
    ...(locked.length > 0 ? [`(deny file-write* ${filters('subpath', 'LOCKED', locked)})`] : []),
    ...anchoredOf({ writable, locked: gitPaths.filter((at) => writable.some((place) => isWithin(at, place))) }).map((at) => `(deny file-write-unlink (require-all (vnode-type DIRECTORY) (literal ${param('ANCHOR', at)})))`),
    // Writes through a read-only descriptor (F_MAKECOMPRESSED, F_TRANSFEREXTENTS).
    '(deny system-fcntl (fcntl-command 80 110))',
  ];

  return { profile: lines.join('\n'), params };
}

export const seatbelt: NativeSandbox = {
  provider: 'seatbelt',
  isolation: 'worktree',
  isUnattended: false,

  async preflight(env) {
    if (onPath(SW_VERS, undefined) === undefined) return { ok: false, message: NOT_MACOS };
    const version = await run(SW_VERS, ['-productVersion'], env);

    if (!version.ok) return { ok: false, message: `sw_vers could not tell this Mac's version (${version.message}). ${NOT_MACOS}` };
    const major = Number(version.stdout.trim().split('.')[0]);

    if (!(major >= 14)) return { ok: false, message: `seatbelt needs macOS 14 or later, and this Mac runs ${version.stdout.trim()}. Update macOS, or use provider: sbx or docker` };

    if (onPath(SANDBOX_EXEC, undefined) === undefined) return { ok: false, message: `${SANDBOX_EXEC}, which macOS ships, is missing. Use provider: sbx or docker` };
    const probe = await run(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', 'true'], env);

    if (probe.ok) return { ok: true };

    // macOS does not start a sandbox inside another: the runtime then runs under an app's or a tool's own.
    if (/Operation not permitted/i.test(probe.message)) {
      return { ok: false, message: `${SANDBOX_EXEC} could not start a sandbox (${probe.message}). This process already runs inside a macOS sandbox, such as one an app or another tool started it in, and macOS does not start one inside another. Start teamai from a terminal outside it, or use provider: sbx or docker` };
    }

    return { ok: false, message: `${SANDBOX_EXEC} could not start a sandbox (${probe.message}). Run \`${SANDBOX_EXEC} -p '(version 1)(allow default)' true\` to see why, and start again` };
  },

  wrap(sandboxed) {
    const { profile, params } = profileOf(sandboxed);

    return { command: SANDBOX_EXEC, args: ['-p', profile, ...params.flatMap((param) => ['-D', param]), ...sandboxed.argv] };
  },
};
