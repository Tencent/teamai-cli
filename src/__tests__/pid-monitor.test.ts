import { describe, it, expect } from 'vitest';
import {
  isProcessAlive,
  getProcessComm,
  getParentPid,
  parseWindowsProcessTable,
  resolveMonitorPid,
  walkToNonShell,
} from '../pid-monitor.js';

describe('isProcessAlive', () => {
    it('returns true for current process', () => {
        expect(isProcessAlive(process.pid)).toBe(true);
    });

    it('returns false for non-existent PID', () => {
        // PID 99999999 is extremely unlikely to exist
        expect(isProcessAlive(99999999)).toBe(false);
    });

    // PID 1 is init/systemd. Windows has no PID 1, so kill(1, 0) is legitimately
    // ESRCH there — the expectation is POSIX-only, not a gap in the port.
    it.skipIf(process.platform === 'win32')('returns true for PID 1 (init/systemd)', () => {
        // PID 1 always exists on Linux, may return EPERM
        expect(isProcessAlive(1)).toBe(true);
    });
});

describe('getProcessComm', () => {
    it('returns a string for current process', () => {
        const comm = getProcessComm(process.pid);
        expect(comm).toBeDefined();
        expect(typeof comm).toBe('string');
        expect(comm!.length).toBeGreaterThan(0);
    });

    it('returns undefined for non-existent PID', () => {
        expect(getProcessComm(99999999)).toBeUndefined();
    });
});

describe('getParentPid', () => {
    it('returns a number for current process', () => {
        const ppid = getParentPid(process.pid);
        expect(ppid).toBeDefined();
        expect(ppid).toBeGreaterThan(0);
    });

    it('matches process.ppid for current process', () => {
        const ppid = getParentPid(process.pid);
        expect(ppid).toBe(process.ppid);
    });

    it('returns undefined for non-existent PID', () => {
        expect(getParentPid(99999999)).toBeUndefined();
    });
});

describe('resolveMonitorPid', () => {
    it('returns a valid PID for current process ppid', () => {
        const pid = resolveMonitorPid(process.ppid);
        expect(pid).toBeGreaterThan(0);
    });

    it('returns the input PID when it is not a shell', () => {
        // process.ppid should be a node process (vitest runner), not a shell
        const pid = resolveMonitorPid(process.ppid);
        // Should return ppid itself if it's not a shell, or walk up to a non-shell
        expect(isProcessAlive(pid)).toBe(true);
    });
});

describe('parseWindowsProcessTable', () => {
    it('reads the rows Win32_Process emits', () => {
        const table = parseWindowsProcessTable(
            '1234 100 node.exe\r\n' + '100 4 bash.exe\r\n' + '4 0 System\r\n',
        );

        expect(table.size).toBe(3);
        expect(table.get(1234)).toEqual({ ppid: 100, comm: 'node.exe' });
        expect(table.get(100)).toEqual({ ppid: 4, comm: 'bash.exe' });
        expect(table.get(4)).toEqual({ ppid: 0, comm: 'System' });
    });

    it('ignores blank lines and non-row noise', () => {
        const table = parseWindowsProcessTable('\r\n#< CLIXML\r\n\n4321 111 pwsh.exe\n');

        expect(table.size).toBe(1);
        expect(table.get(4321)).toEqual({ ppid: 111, comm: 'pwsh.exe' });
    });

    it('keeps a name containing spaces whole', () => {
        const table = parseWindowsProcessTable('7 6 C:\\Program Files\\x.exe\r\n');

        expect(table.get(7)).toEqual({ ppid: 6, comm: 'C:\\Program Files\\x.exe' });
    });
});

describe('walkToNonShell', () => {
    // The hook's parent is a shell, the shell's parent is the AI tool: Windows
    // reports the shell as `bash.exe`, so the comparison has to see through the
    // extension. Exported for tests because CI has no Windows runner to run the
    // real Win32_Process query on.
    const lookup = (comms: Record<number, string>, ppids: Record<number, number>) => ({
        commOf: (pid: number) => comms[pid],
        ppidOf: (pid: number) => ppids[pid],
    });

    it('skips a shell ancestor and returns the first non-shell one', () => {
        const { commOf, ppidOf } = lookup(
            { 30: 'node.exe', 20: 'bash.exe', 10: 'node.exe' },
            { 30: 20, 20: 10 },
        );

        // Starting at the shell (20) — what the hook records as its ppid — the
        // tool (10) is the answer, not the shell.
        expect(walkToNonShell(20, commOf, ppidOf)).toBe(10);
    });

    it('matches shell names case-insensitively and with the .exe suffix', () => {
        const { commOf, ppidOf } = lookup({ 20: 'BASH.EXE', 10: 'node.exe' }, { 20: 10 });

        expect(walkToNonShell(20, commOf, ppidOf)).toBe(10);
    });

    it('stops after five levels when every ancestor is a shell', () => {
        const comms: Record<number, string> = { 10: 'node.exe' };
        const ppids: Record<number, number> = { 20: 10 };
        for (let pid = 30; pid <= 80; pid += 10) {
            comms[pid] = 'bash.exe';
            ppids[pid] = pid - 10;
        }

        // 80 -> 70 -> 60 -> 50 -> 40 -> 30 is five hops, so the tool at 10 stays out of reach.
        expect(walkToNonShell(80, (p) => comms[p], (p) => ppids[p])).toBe(30);
    });

    it('falls back to the hook parent when nothing can be read', () => {
        expect(walkToNonShell(4242, () => undefined, () => undefined)).toBe(4242);
    });
});
