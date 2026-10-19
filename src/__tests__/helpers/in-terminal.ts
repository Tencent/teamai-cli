import { spawnSync } from 'node:child_process';

/**
 * Runs argv[2:] as the foreground job of a new terminal (os.forkpty), writes
 * its pid to argv[1], and exits as it did.
 */
export const IN_TERMINAL = [
  'import os, sys',
  'pid, fd = os.forkpty()',
  'if pid == 0:',
  '    os.execvp(sys.argv[2], sys.argv[2:])',
  'open(sys.argv[1], "w").write(str(pid))',
  'while True:',
  '    try:',
  '        if not os.read(fd, 4096): break',
  '    except OSError:',
  '        break',
  'sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))',
].join('\n');

/**
 * Like IN_TERMINAL, and the terminal is typed into: runs argv[4:] as its
 * foreground job, writes the pid to argv[1], appends everything the terminal
 * prints to argv[2], and types into it whatever is appended to argv[3]
 * (`\x03` is Ctrl-C).
 */
export const TYPED_TERMINAL = [
  'import os, select, sys',
  'pid, fd = os.forkpty()',
  'if pid == 0:',
  '    os.execvp(sys.argv[4], sys.argv[4:])',
  'open(sys.argv[1], "w").write(str(pid))',
  'out = open(sys.argv[2], "ab", buffering=0)',
  'sent = 0',
  'while True:',
  '    if select.select([fd], [], [], 0.05)[0]:',
  '        try:',
  '            data = os.read(fd, 4096)',
  '        except OSError:',
  '            break',
  '        if not data: break',
  '        out.write(data)',
  '    typed = open(sys.argv[3], "rb").read() if os.path.exists(sys.argv[3]) else b""',
  '    if len(typed) > sent:',
  '        os.write(fd, typed[sent:])',
  '        sent = len(typed)',
  'sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))',
].join('\n');

/** Whether python3 with os.forkpty is available to run IN_TERMINAL and TYPED_TERMINAL. */
export const hasPython = spawnSync('python3', ['-c', 'import os; os.forkpty'], { stdio: 'ignore' }).status === 0;
