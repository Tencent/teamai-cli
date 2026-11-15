import { describe, expect, it } from 'vitest';
import { boundedStdout, fitReason, PromptLeaseSchema, runsCommand, RuntimeMessageSchema, RuntimeRequestSchema, UNAVAILABLE_REASON_MAX } from './protocol.js';

describe('a reason a runtime gives in init\'s unavailable', () => {
  it('stays as it is when it fits', () => {
    expect(fitReason('acme-claude is not in the image: add it, or run the step with --driver local.')).toBe('acme-claude is not in the image: add it, or run the step with --driver local.');
  });

  it('is cut to the most init\'s reply holds, ending with an ellipsis, so the reply still parses', () => {
    const fitted = fitReason(`${'x'.repeat(UNAVAILABLE_REASON_MAX)}tail`);

    expect(fitted).toHaveLength(UNAVAILABLE_REASON_MAX);
    expect(fitted.endsWith('…')).toBe(true);
    expect(RuntimeMessageSchema.safeParse({ type: 'init', ok: true, can: {}, unavailable: { claude: fitted } }).success).toBe(true);
  });
});


// T3 Code and Paseo start a provider's Binary path or command as given: a bare name from PATH, an absolute path as it is.
describe('whether an app\'s provider runs an instance\'s command', () => {
  it.each([
    { executable: undefined, command: 'acme-claude', platform: 'darwin', expandsHome: false, runs: false },
    { executable: 'acme-claude', command: 'acme-claude', platform: 'darwin', expandsHome: false, runs: true },
    { executable: '/opt/acme/bin/acme-claude', command: 'acme-claude', platform: 'darwin', expandsHome: false, runs: true },
    { executable: '/opt/acme/bin/acme-claude', command: '/opt/acme/bin/acme-claude', platform: 'linux', expandsHome: false, runs: true },
    { executable: '/opt/acme/bin/acme-claude-old', command: 'acme-claude', platform: 'darwin', expandsHome: false, runs: false },
    { executable: '/opt/acme/bin/Acme-Claude', command: 'acme-claude', platform: 'darwin', expandsHome: false, runs: false },
    { executable: 'bin/acme-claude', command: 'acme-claude', platform: 'linux', expandsHome: false, runs: false },
    // T3 Code expands a Binary path in the home folder, such as Claude's own local install; Paseo does not.
    { executable: '~/.claude/local/claude', command: 'claude', platform: 'darwin', expandsHome: true, runs: true },
    { executable: '~\\bin\\acme-claude.exe', command: 'acme-claude', platform: 'win32', expandsHome: true, runs: true },
    { executable: '~/bin/acme-claude', command: 'acme-claude', platform: 'darwin', expandsHome: false, runs: false },
    { executable: '~acme/bin/acme-claude', command: 'acme-claude', platform: 'linux', expandsHome: true, runs: false },
    { executable: '/opt/acme/bin/acme-claude', command: '/usr/local/bin/acme-claude', platform: 'linux', expandsHome: false, runs: false },
    { executable: 'C:\\Acme\\bin\\Acme-Claude.EXE', command: 'acme-claude', platform: 'win32', expandsHome: false, runs: true },
    { executable: 'C:\\Acme\\bin\\acme-claude.cmd', command: 'acme-claude', platform: 'win32', expandsHome: false, runs: true },
    { executable: 'acme-claude.exe', command: 'acme-claude', platform: 'win32', expandsHome: false, runs: true },
    { executable: 'C:\\Acme\\bin\\acme-claude.ps1', command: 'acme-claude', platform: 'win32', expandsHome: false, runs: false },
  ] as const)('$executable runs $command on $platform, expanding ~/ $expandsHome: $runs', ({ executable, command, platform, expandsHome, runs }) => {
    expect(runsCommand({ executable, command, platform, expandsHome })).toBe(runs);
  });
});

describe('the stdout an exited carries', () => {
  const CUT = '[teamai: only the last 64 KiB of stdout follow]\n';

  it('is the whole stdout up to 64 KiB', () => {
    const stdout = 'x'.repeat(65_536);

    expect(boundedStdout(stdout)).toBe(stdout);
  });

  it('is the last 64 KiB after a marker past that', () => {
    expect(boundedStdout(`early${'x'.repeat(65_536)}`)).toBe(`${CUT}${'x'.repeat(65_536)}`);
  });

  it('never starts with half a character the cut split', () => {
    expect(boundedStdout(`\u{1F600}${'x'.repeat(65_535)}`)).toBe(`${CUT}${'x'.repeat(65_535)}`);
  });
});

describe('a prompt that continues an earlier conversation', () => {
  const lease = { step: 'fix', tool: 'claude', prompt: 'Fix it.', result: '/w/result.json', permissions: 'approval-required', interactive: false } as const;

  it('names the place and the op of the prompt whose conversation it continues', () => {
    expect(PromptLeaseSchema.parse({ ...lease, continue: { handle: 't3-r1-a1', op: 'op-0123abcd' } })).toEqual({ ...lease, continue: { handle: 't3-r1-a1', op: 'op-0123abcd' } });
  });

  it('refuses a key the conversation it continues does not have, naming it', () => {
    const parsed = PromptLeaseSchema.safeParse({ ...lease, continue: { handle: 't3-r1-a1', op: 'op-0123abcd', thread: 'th-1' } });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([expect.objectContaining({ code: 'unrecognized_keys', keys: ['thread'], path: ['continue'] })]);
  });
});

describe('a runtime that wakes fleet members', () => {
  const OP = 'op-0123abcd';

  it('says so in its init reply', () => {
    expect(RuntimeMessageSchema.safeParse({ type: 'init', ok: true, can: {}, prompt: true, wake: true }).success).toBe(true);
  });

  it('reads a wake request as teamai writes it', () => {
    const wake = { type: 'wake', op: OP, pool: 'gpu', repository: 'https://example.com/acme/app.git', message: 'teamai workflow resume --pool gpu --next', title: 'Fleet member for gpu' };

    expect(RuntimeRequestSchema.parse(JSON.parse(JSON.stringify(wake)))).toEqual(wake);
  });

  it('answers a wake with where it launched the member', () => {
    expect(RuntimeMessageSchema.safeParse({ op: OP, event: 'woken', where: 'studio-mac', display: { label: 'Fleet member for gpu', url: 't3://thread/th-1' } }).success).toBe(true);
    expect(RuntimeMessageSchema.safeParse({ op: OP, event: 'woken' }).success).toBe(false);
  });
});

describe('a prompt the host slot answers, and the limits a runtime stops its tool at', () => {
  const lease = { step: 'fix', tool: 'claude', prompt: 'Fix it.', result: '/w/result.json', permissions: 'approval-required', interactive: false } as const;
  const OP = 'op-0123abcd';

  it('reads an answer lease', () => {
    expect(PromptLeaseSchema.parse({ ...lease, answer: true })).toEqual({ ...lease, answer: true });
  });

  it('reads the limits as teamai sends them', () => {
    const limits = { budget: { tokens: 20_000 }, timeoutMs: 600_000, idleMs: 120_000 };

    expect(PromptLeaseSchema.parse({ ...lease, limits })).toEqual({ ...lease, limits });
  });

  it('refuses a limit it does not know, naming it', () => {
    const parsed = PromptLeaseSchema.safeParse({ ...lease, limits: { timeoutMs: 600_000, turns: 3 } });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([expect.objectContaining({ code: 'unrecognized_keys', keys: ['turns'], path: ['limits'] })]);
  });

  it('reads a finished prompt with the limit its tool was stopped at, live and on reattach', () => {
    const finished = { session: { tool: 'claude', id: 'session-1' }, result: { output: {} }, stopped: 'budget' };

    expect(RuntimeMessageSchema.safeParse({ op: OP, event: 'finished', ...finished }).success).toBe(true);
    expect(RuntimeMessageSchema.safeParse({ event: 'alive', handle: 'toy-1', ops: [{ op: OP, state: 'finished', ...finished }] }).success).toBe(true);
    expect(RuntimeMessageSchema.safeParse({ op: OP, event: 'finished', ...finished, stopped: 'turns' }).success).toBe(false);
  });

  it('reads an init reply that says it runs tools in the attempt\'s tool home and keeps conversations', () => {
    expect(RuntimeMessageSchema.safeParse({ type: 'init', ok: true, can: {}, prompt: true, toolHome: true, conversations: true }).success).toBe(true);
  });
});

describe('a reply read strictly, at every depth', () => {
  const OP = 'op-0123abcd';
  const finished = { session: { tool: 'claude', id: 'session-1' }, result: { output: {} } };

  it.each([
    { what: 'a can key', reply: { type: 'init', ok: true, can: { max_turn: true } }, key: 'max_turn', path: ['can'] },
    { what: 'a key of a confined offer', reply: { type: 'init', ok: true, can: { confined: [{ level: 'verified', tools: ['claude'], acess: 'full' }] } }, key: 'acess', path: ['can', 'confined', 0] },
    { what: 'a failure key', reply: { op: OP, event: 'failed', failure: { code: 'exec_failed', message: 'm', hint: 'x' } }, key: 'hint', path: ['failure'] },
    { what: 'a session key', reply: { op: OP, event: 'finished', ...finished, session: { tool: 'claude', id: 's', path: '/x' } }, key: 'path', path: ['session'] },
    { what: 'a kept confinement key', reply: { op: OP, event: 'finished', ...finished, confined: { level: 'verified', access: 'full', dir: '/x' } }, key: 'dir', path: ['confined'] },
    { what: 'a key of an operation reattach reports', reply: { event: 'alive', handle: 'toy-1', ops: [{ op: OP, state: 'running', pid: 4 }] }, key: 'pid', path: ['ops', 0] },
  ])('refuses $what it does not know, naming it', ({ reply, key, path }) => {
    const parsed = RuntimeMessageSchema.safeParse(reply);

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.flatMap((issue) => ('errors' in issue ? issue.errors.flat() : [issue]))).toContainEqual(expect.objectContaining({ code: 'unrecognized_keys', keys: [key], path }));
  });
});
