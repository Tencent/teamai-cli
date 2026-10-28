import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { attemptEnv } from '../workflow/attempt-marker.js';
import { parseSkillCall } from '../workflow/drivers/skill/skill-driver.js';
import { AttemptIdSchema, RunIdSchema } from '../workflow/store.js';
import {
  ackLiteral, adoptLiteral, chooseHostLiteral, describeLiteral, generatedStartPatterns, INVOCATIONS, localStartLiteral, nextLiteral, personRespondLiteral, pollLiteral,
  reportLiteral, respondLiteral, resumeLiteral, runnerArgs, skillResumeLiteral, startLiteral, takeoverLiteral, unavailableLiteral, type Invocation,
} from '../workflow/drivers/skill/literals.js';
import { loadCommandTable } from './helpers/command-table.js';

const ROOT = path.join(import.meta.dirname, '../..');
const RUN = RunIdSchema.parse('r0123456789abcdef');
const ATTEMPT = AttemptIdSchema.parse('a01234567');

/** The `allowed-tools` patterns the teamai stub pre-approves. */
function stubPatterns(): string[] {
  const stub = fs.readFileSync(path.join(ROOT, 'skills/teamai/SKILL.md'), 'utf8');
  return (stub.match(/^allowed-tools: (.*)$/m)?.[1] ?? '').split(', ');
}

let program: Command;
beforeAll(async () => { program = await loadCommandTable(); });
afterEach(() => { vi.unstubAllEnvs(); });

/** The words of `literal` after its invocation, single-quoted words unquoted, as a shell would pass them. */
function words(literal: string, invocation: Invocation): string[] {
  expect(literal.startsWith(`${invocation} `), literal).toBe(true);
  return (literal.slice(invocation.length + 1).match(/'[^']*'|\S+/g) ?? []).map((word) => word.replace(/^'(.*)'$/, '$1'));
}

/** Parses `args` with the real `workflow <sub>` command, as Commander hands them to its action. */
function parsed(args: string[]): { sub: string; operands: string[]; options: Record<string, unknown> } {
  const [group, sub, ...rest] = args;
  const leaf = program.commands.find((command) => command.name() === group)?.commands.find((command) => command.name() === sub);
  if (!leaf || sub === undefined) throw new Error(`no command ${group} ${sub}`);
  // Commander keeps option values between parses; each literal starts from none.
  for (const option of leaf.options) leaf.setOptionValue(option.attributeName(), undefined);
  const { operands, unknown } = leaf.parseOptions(rest);
  expect(unknown, args.join(' ')).toEqual([]);
  const options = Object.fromEntries(Object.entries(leaf.opts()).filter(([, value]) => value !== undefined));
  return { sub, operands, options };
}

/** The call a `--driver skill` literal makes, read the way `workflow-commands.ts` reads it. */
function skillCall(literal: string, invocation: Invocation, env: NodeJS.ProcessEnv = {}) {
  const { sub, operands, options: { driver, ...options } } = parsed(words(literal, invocation));
  expect(driver, literal).toBe('skill');
  const [operand = ''] = operands;
  if (sub === 'start') return parseSkillCall({ kind: 'start', name: operand, options }, env);
  if (sub === 'next' || sub === 'resume' || sub === 'report') return parseSkillCall({ kind: sub, run: operand, options }, env);
  if (sub === 'respond') {
    const [, step = '', choice = ''] = operands;
    return parseSkillCall({ kind: 'respond', run: operand, step, choice, options }, env);
  }
  throw new Error(`not a skill driver call: ${literal}`);
}

describe.each(INVOCATIONS)('skill driver literals run as %s', (invocation) => {
  it('parse into the calls they name', () => {
    expect(skillCall(describeLiteral(invocation, 'check'), invocation)).toEqual({ kind: 'describe', name: 'check' });
    expect(skillCall(startLiteral(invocation, 'check'), invocation)).toEqual({ kind: 'start', name: 'check', answers: { confirmed: false }, inputs: undefined });
    const filled = startLiteral(invocation, 'check', { parallel: 2, confirmed: true, inputs: true }).replace('{inputs}', '{"task":"a fix"}');
    expect(filled).not.toBe(startLiteral(invocation, 'check', { parallel: 2, confirmed: true, inputs: true }));
    expect(skillCall(filled, invocation)).toEqual({ kind: 'start', name: 'check', answers: { parallel: 2, confirmed: true }, inputs: { task: 'a fix' } });
    expect(skillCall(startLiteral(invocation, 'check', { noJudge: true }), invocation)).toEqual({ kind: 'start', name: 'check', answers: { confirmed: false, judge: false }, inputs: undefined });
    expect(skillCall(nextLiteral(invocation, RUN), invocation)).toEqual({ kind: 'next', run: RUN, wait: false });
    expect(skillCall(pollLiteral(invocation, RUN), invocation)).toEqual({ kind: 'next', run: RUN, wait: true });
    expect(skillCall(takeoverLiteral(invocation, RUN), invocation)).toEqual({ kind: 'takeover', run: RUN, confirmed: false });
    expect(skillCall(skillResumeLiteral(invocation, RUN), invocation)).toEqual({ kind: 'resume', run: RUN, claim: false, confirmed: false, answers: {} });
    expect(skillCall(skillResumeLiteral(invocation, RUN, { claim: true, parallel: 2, hitl: 'auto-approve', noJudge: true }), invocation))
      .toEqual({ kind: 'resume', run: RUN, claim: true, confirmed: false, answers: { parallel: 2, hitl: 'auto-approve', judge: false } });
    expect(skillCall(skillResumeLiteral(invocation, RUN, { hitl: 'recommend' }), invocation)).toEqual({ kind: 'resume', run: RUN, claim: false, confirmed: false, answers: { hitl: 'recommend' } });
    expect(skillCall(skillResumeLiteral(invocation, RUN, { claim: true, confirmed: true }), invocation)).toEqual({ kind: 'resume', run: RUN, claim: true, confirmed: true, answers: {} });
    expect(skillCall(takeoverLiteral(invocation, RUN, { confirmed: true }), invocation)).toEqual({ kind: 'takeover', run: RUN, confirmed: true });
    expect(skillCall(reportLiteral(invocation, RUN, ATTEMPT), invocation)).toEqual({ kind: 'report', run: RUN, attempt: ATTEMPT, role: 'agent', modelUnavailable: false });
    expect(skillCall(unavailableLiteral(invocation, RUN, ATTEMPT), invocation)).toEqual({ kind: 'report', run: RUN, attempt: ATTEMPT, role: 'agent', modelUnavailable: true });
    expect(skillCall(chooseHostLiteral(invocation, RUN, 'h2'), invocation)).toEqual({ kind: 'choose', run: RUN, choice: 'h2' });
    expect(skillCall(ackLiteral(invocation, RUN, ATTEMPT), invocation)).toEqual({ kind: 'ack', run: RUN, attempt: ATTEMPT });
    const adopt = adoptLiteral(invocation, RUN, ATTEMPT).replace('{dir}', '/hosts/the place');
    expect(adopt).not.toBe(adoptLiteral(invocation, RUN, ATTEMPT));
    expect(skillCall(adopt, invocation)).toEqual({ kind: 'adopt', run: RUN, attempt: ATTEMPT, dir: '/hosts/the place' });
    expect(skillCall(adoptLiteral(invocation, RUN, ATTEMPT, '/hosts/the place'), invocation)).toEqual({ kind: 'adopt', run: RUN, attempt: ATTEMPT, dir: '/hosts/the place' });
    expect(skillCall(startLiteral(invocation, 'check', { hitl: 'recommend' }), invocation)).toEqual({ kind: 'start', name: 'check', answers: { confirmed: false, hitl: 'recommend' }, inputs: undefined });
    expect(skillCall(startLiteral(invocation, 'check', { hitl: 'auto-approve' }), invocation)).toEqual({ kind: 'start', name: 'check', answers: { confirmed: false, hitl: 'auto-approve' }, inputs: undefined });
    expect(skillCall(respondLiteral(invocation, RUN, { step: 'items[0].ask', pass: 2, choice: 'yes' }), invocation))
      .toEqual({ kind: 'respond', run: RUN, step: 'items[0].ask', pass: 2, choice: 'yes' });
  });

  it('answer a required approval with the person\'s literal, which runs respond without a driver', () => {
    expect(parsed(words(personRespondLiteral(invocation, RUN, { step: 'items[0].ask', pass: 1, choice: 'no' }), invocation)))
      .toEqual({ sub: 'respond', operands: [RUN, 'items[0].ask', 'no'], options: { pass: '1' } });
  });

  it('start the local driver with the local start literal', () => {
    expect(parsed(words(localStartLiteral(invocation, 'check'), invocation))).toEqual({ sub: 'start', operands: ['check'], options: { driver: 'local' } });
  });

  it('continue the run with the local driver with the resume literal', () => {
    expect(parsed(words(resumeLiteral(invocation, RUN), invocation))).toEqual({ sub: 'resume', operands: [RUN], options: {} });
  });

  it('name the default prompt tool of a local run in the local start and resume literals', () => {
    expect(parsed(words(localStartLiteral(invocation, 'check', { tool: 'claude' }), invocation))).toEqual({ sub: 'start', operands: ['check'], options: { driver: 'local', tools: 'default=claude' } });
    expect(parsed(words(resumeLiteral(invocation, RUN, { tool: 'claude' }), invocation))).toEqual({ sub: 'resume', operands: [RUN], options: { tools: 'default=claude' } });
  });

  it('describe, and start no run, whatever follows the pre-approved describe', () => {
    const trailing = `${describeLiteral(invocation, 'check')} --confirmed --parallel 3 --inputs '{}'`;
    expect(skillCall(trailing, invocation)).toEqual({ kind: 'describe', name: 'check' });
  });

  it('pre-approve no call that starts a run, and start only the workflow a generated skill names', () => {
    const prefixes = (patterns: string[]) => patterns.map((pattern) => pattern.replace(/^Bash\((.*):\*\)$/, '$1'));
    const starts = [startLiteral(invocation, 'ship'), startLiteral(invocation, 'ship', { parallel: 2, confirmed: true, inputs: true })];
    for (const prefix of prefixes(stubPatterns())) expect(starts.filter((literal) => literal.startsWith(prefix)), prefix).toEqual([]);
    const generated = prefixes(generatedStartPatterns('ship', 'go')).filter((prefix) => prefix.startsWith(`${invocation} `));
    expect(generated).toEqual([`${invocation} workflow start ship --driver skill`, `${invocation} workflow start go --driver skill`]);
    for (const literal of starts) expect(generated.some((prefix) => literal.startsWith(prefix)), literal).toBe(true);
    expect(generated.some((prefix) => startLiteral(invocation, 'ship-issue').startsWith(prefix))).toBe(false);
  });
});

describe('--tools of the skill driver', () => {
  const ONE_TOOL = '--driver skill takes only --tools default=<tool>, the tool this coding session works in';

  it('names this coding session\'s tool with default=<tool> on describe, start and resume, and the start literal carries it', () => {
    expect(parseSkillCall({ kind: 'start', name: 'check', options: { describe: true, tools: 'default=omp' } }, {})).toEqual({ kind: 'describe', name: 'check', tool: 'omp' });
    expect(parseSkillCall({ kind: 'start', name: 'check', options: { tools: 'default=omp' } }, {})).toMatchObject({ kind: 'start', name: 'check', tool: 'omp' });
    expect(parseSkillCall({ kind: 'resume', run: RUN, options: { tools: ' default = hermes ' } }, {})).toMatchObject({ kind: 'resume', run: RUN, tool: 'hermes' });
    expect(skillCall(startLiteral('teamai', 'check', { tool: 'omp' }), 'teamai')).toMatchObject({ kind: 'start', name: 'check', tool: 'omp' });
    expect(skillCall(describeLiteral('teamai', 'check', { tool: 'omp' }), 'teamai')).toEqual({ kind: 'describe', name: 'check', tool: 'omp' });
    expect(skillCall(skillResumeLiteral('teamai', RUN, { claim: true, tool: 'omp' }), 'teamai')).toMatchObject({ kind: 'resume', run: RUN, claim: true, tool: 'omp' });
    // The describe a session with no tool is asked to run, once it fills the {tool} slot.
    expect(skillCall(describeLiteral('teamai', 'check', { tool: '{tool}' }).replace("'{tool}'", 'omp'), 'teamai')).toEqual({ kind: 'describe', name: 'check', tool: 'omp' });
  });

  it('refuses a role map or a tool teamai does not know', () => {
    for (const tools of ['implementer=codex', 'default=claude,implementer=codex', 'default=']) {
      expect(parseSkillCall({ kind: 'start', name: 'check', options: { tools } }, {}), tools).toEqual({ error: { code: 'invalid_arguments', message: ONE_TOOL, next: null } });
    }
    expect(parseSkillCall({ kind: 'start', name: 'check', options: { tools: 'default=vim' } }, {}))
      .toEqual({ error: { code: 'invalid_arguments', message: expect.stringMatching(/^--tools default=vim names no tool teamai knows: claude, .*hermes/), next: null } });
    expect(parseSkillCall({ kind: 'start', name: 'check', options: { describe: true, tools: 'default={tool}' } }, {}))
      .toEqual({ error: { code: 'invalid_arguments', message: expect.stringMatching(/^--tools default=\{tool\} names no tool teamai knows: claude, /), next: null } });
  });
});

describe('start and respond options of the skill driver', () => {
  it('take one answer to how optional gates are answered, and the pass of the gate an answer is for', () => {
    expect(parseSkillCall({ kind: 'start', name: 'check', options: { hitl: 'recommend', autoApprove: true } }, {}))
      .toEqual({ error: { code: 'invalid_arguments', message: '--hitl and --auto-approve answer the same question: pass one of them, as the describe reply offered', next: null } });
    expect(parseSkillCall({ kind: 'start', name: 'check', options: { hitl: 'auto' } }, {}))
      .toEqual({ error: { code: 'invalid_arguments', message: '--hitl takes person or recommend, as the describe reply offered', next: null } });
    expect(parseSkillCall({ kind: 'respond', run: RUN, step: 'review', choice: 'yes', options: {} }, {}))
      .toEqual({ error: { code: 'invalid_arguments', message: '--driver skill needs --pass, as the choose action printed it', next: null } });
  });
});

describe('next options of the skill driver', () => {
  it('name the host choices, the shape of an offer, and that one call takes one of --wait, --takeover, --choice and --ack', () => {
    expect(parseSkillCall({ kind: 'next', run: RUN, options: { choice: 'h9' } }, {}))
      .toEqual({ error: { code: 'invalid_arguments', message: '--choice takes the id of a host question option: h1, h2, h3, h4', next: null } });
    expect(parseSkillCall({ kind: 'next', run: RUN, options: { ack: ATTEMPT } }, {}))
      .toEqual({ error: { code: 'invalid_arguments', message: `--ack takes the offer of a dispatch action, such as dispatch.a1b2c3d4e; got ${ATTEMPT}`, next: null } });
    expect(parseSkillCall({ kind: 'next', run: RUN, options: { wait: true, ack: `dispatch.${ATTEMPT}` } }, {}))
      .toEqual({ error: { code: 'invalid_arguments', message: 'next takes at most one of --wait, --takeover, --choice, --ack and --adopt', next: null } });
    expect(parseSkillCall({ kind: 'next', run: RUN, options: { wait: true, takeover: true } }, {}))
      .toEqual({ error: { code: 'invalid_arguments', message: 'next takes at most one of --wait, --takeover, --choice, --ack and --adopt', next: null } });
  });
});

describe('the adopt of the skill driver', () => {
  it('takes --attempt and --adopt together, and no other next option beside them', () => {
    expect(parseSkillCall({ kind: 'next', run: RUN, options: { attempt: ATTEMPT } }, {}))
      .toEqual({ error: { code: 'invalid_arguments', message: '--driver skill takes --attempt and --adopt together, as the adopt of a place action prints them', next: null } });
    expect(parseSkillCall({ kind: 'next', run: RUN, options: { attempt: ATTEMPT, adopt: '/hosts/place', ack: `dispatch.${ATTEMPT}` } }, {}))
      .toEqual({ error: { code: 'invalid_arguments', message: 'next takes at most one of --wait, --takeover, --choice, --ack and --adopt', next: null } });
  });
});

describe('the runner', () => {
  it('reports its own attempt: the runner arguments carry the attempt, and the marker makes it the runner', () => {
    const args = runnerArgs(RUN, ATTEMPT);
    const { sub, operands, options: { driver, ...options } } = parsed(args);
    expect([sub, driver]).toEqual(['report', 'skill']);
    expect(parseSkillCall({ kind: 'report', run: operands[0] ?? '', options }, attemptEnv(RUN, ATTEMPT, 'attended')))
      .toEqual({ kind: 'report', run: RUN, attempt: ATTEMPT, role: 'runner' });
    expect(parseSkillCall({ kind: 'report', run: operands[0] ?? '', options }, attemptEnv(RUN, 'a76543210', 'attended')))
      .toEqual({ kind: 'report', run: RUN, attempt: ATTEMPT, role: 'agent', modelUnavailable: false });
  });
});

describe('the files an agent reads', () => {
  it('the teamai stub pre-approves the skill commands and the skill driver calls, and nothing else', () => {
    // None of the workflow calls can start a run: `--describe` comes before the name.
    const calls = ['skill', 'workflow start --describe', 'workflow next', 'workflow report', 'workflow respond'];
    expect([...stubPatterns()].sort()).toEqual(INVOCATIONS.flatMap((invocation) => calls.map((call) => `Bash(${invocation} ${call}:*)`)).sort());
  });

  it('the workflow guide starts with the describe literal', () => {
    const guide = fs.readFileSync(path.join(ROOT, 'skill-data/workflow/SKILL.md'), 'utf8');
    expect(guide).toContain(`\`${describeLiteral('teamai', '<name>')}\``);
  });
});
