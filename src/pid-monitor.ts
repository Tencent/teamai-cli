import fs from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';

import { windowsPowerShell } from './utils/powershell.js';

// ─── Process tree helpers ──────────────────────────────
//
//  Used by dashboard-collector (at hook time) to find the AI tool PID,
//  and by dashboard server (at check time) to verify PID liveness.
//
//  One reader per platform shape: Linux /proc (zero-cost), the BSD-style
//  `ps -o` fallback, and — on Windows, which has neither — a single
//  Win32_Process query. Git Bash ships an MSYS `ps` that rejects `-o`, so the
//  ps(1) fallback cannot stand in there.

/** Shell executable names to skip when walking the process tree. */
const SHELL_COMMS = new Set([
    'sh', 'bash', 'zsh', 'fish', 'dash', 'csh', 'tcsh', 'ksh',
]);

/**
 * Windows reports the image name with its extension (`bash.exe`); POSIX `comm`
 * never carries one.
 */
function normalizeComm(comm: string): string {
    return comm.replace(/\.exe$/i, '').toLowerCase();
}

export interface ProcessEntry {
    ppid: number;
    comm: string;
}

/**
 * Parse the `<pid> <ppid> <name>` rows readWindowsProcessTable() asks PowerShell
 * for. Exported because the CI matrix has no Windows runner: this parser is the
 * only part of the Windows path a POSIX job can pin.
 */
export function parseWindowsProcessTable(text: string): Map<number, ProcessEntry> {
    const table = new Map<number, ProcessEntry>();
    for (const line of text.split(/\r?\n/)) {
        const row = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        if (!row) continue;
        table.set(Number(row[1]), { ppid: Number(row[2]), comm: row[3] });
    }
    return table;
}

/**
 * One query for the whole process table: the walk needs up to five ancestors,
 * so a per-pid PowerShell start would cost more than the whole answer. Returns
 * undefined when PowerShell cannot be reached; callers then fall back to the
 * POSIX readers, which fail the same way and leave the walk to its fallback.
 *
 * The 3s bound is a compromise between the two ends this call sits between: it
 * is ~2.4x the idle measurement (1.27s; PowerShell's own startup is 0.59s of
 * it, and wmic would be 0.47s but is gone from Windows 11 24H2 on), and it
 * leaves 1.5s of the session-start collector's 4.5s foreground budget
 * (hook-handlers.ts FOREGROUND_HOOK_TIMEOUT_MS) for the rest of the handler. A
 * hung WMI provider therefore degrades the walk to its fallback instead of
 * delaying the host past its timeout.
 */
function readWindowsProcessTable(): Map<number, ProcessEntry> | undefined {
    try {
        const out = execFileSync(
            windowsPowerShell(),
            [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }',
            ],
            { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
        );
        return parseWindowsProcessTable(out);
    } catch {
        return undefined;
    }
}

/**
 * Get the parent PID of a given process.
 * Returns undefined if PID doesn't exist or can't be read.
 */
export function getParentPid(pid: number): number | undefined {
    if (process.platform === 'win32') {
        const ppid = readWindowsProcessTable()?.get(pid)?.ppid;
        return ppid !== undefined && ppid > 0 ? ppid : undefined;
    }

    // Linux: read /proc/{pid}/stat (fast, no process spawn)
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
        // Field 4 is ppid. Field 2 (comm) can contain spaces/parens, so split carefully.
        // Format: pid (comm) state ppid ...
        const closeParen = stat.lastIndexOf(') ');
        if (closeParen === -1) return undefined;
        const fields = stat.slice(closeParen + 2).split(' ');
        // fields[0]=state, fields[1]=ppid
        const ppid = parseInt(fields[1], 10);
        return ppid > 0 ? ppid : undefined;
    } catch {
        // not Linux, or PID gone
    }

    // macOS/BSD fallback: ps -o ppid= -p <pid>
    try {
        const out = execSync(`ps -o ppid= -p ${pid}`, {
            encoding: 'utf-8',
            timeout: 2000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const ppid = parseInt(out.trim(), 10);
        return ppid > 0 ? ppid : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Get the executable name (comm) of a process.
 * Returns undefined if PID doesn't exist.
 */
export function getProcessComm(pid: number): string | undefined {
    if (process.platform === 'win32') {
        return readWindowsProcessTable()?.get(pid)?.comm;
    }

    // Linux: /proc/{pid}/comm (just the basename, no args)
    try {
        return fs.readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
    } catch {
        // fall through
    }

    // macOS/BSD fallback
    try {
        const out = execSync(`ps -o comm= -p ${pid}`, {
            encoding: 'utf-8',
            timeout: 2000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        // ps on macOS may return full path
        return out.trim().split('/').pop();
    } catch {
        return undefined;
    }
}

/**
 * Walk up the process tree from `hookPpid`, skipping shell wrapper processes
 * (sh, bash, …) and returning the first non-shell ancestor — the AI tool.
 *
 * Falls back to the last PID reached when no non-shell ancestor is found within
 * 5 levels, which is also the answer when nothing can be read at all.
 */
export function walkToNonShell(
    hookPpid: number,
    commOf: (pid: number) => string | undefined,
    ppidOf: (pid: number) => number | undefined,
): number {
    let current = hookPpid;
    let best = hookPpid;

    for (let depth = 0; depth < 5; depth++) {
        const comm = commOf(current);
        if (comm && !SHELL_COMMS.has(normalizeComm(comm))) {
            // Found a non-shell process — this is likely the AI tool
            return current;
        }

        const parent = ppidOf(current);
        if (!parent || parent <= 1) break;

        best = parent;
        current = parent;
    }

    return best;
}

/**
 * Walk up the process tree from the hook's parent PID to find the
 * AI tool's main process. Skips shell wrapper processes (sh, bash, etc.)
 * and returns the first non-shell ancestor.
 *
 * Falls back to the hook's parent PID if no non-shell ancestor is found
 * within 5 levels.
 */
export function resolveMonitorPid(hookPpid: number): number {
    if (process.platform === 'win32') {
        const table = readWindowsProcessTable();
        if (table) {
            return walkToNonShell(
                hookPpid,
                (pid) => table.get(pid)?.comm,
                (pid) => table.get(pid)?.ppid,
            );
        }
    }

    return walkToNonShell(hookPpid, getProcessComm, getParentPid);
}

/**
 * Check if a process with the given PID is still alive.
 * Uses kill(pid, 0) which sends no signal — just checks existence.
 *
 * Returns true if the process exists (even if we lack permission to signal it).
 */
export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return false;  // No such process
        if (code === 'EPERM') return true;   // Exists, but no permission
        return false;
    }
}
