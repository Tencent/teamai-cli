import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { UsageLimits } from '../workflow/usage-limits.js';
import { runtimeStepEnv } from '../workflow/steps/runtime-steps.js';
import { AttemptIdSchema, RunIdSchema } from '../workflow/store.js';
import type { LocalConfig } from '../types.js';

// 13:30 in Madrid, which is UTC+1 in November.
const now = Date.parse('2026-11-08T12:30:00Z');
const zone = 'Europe/Madrid';

describe('when a usage limit resets', () => {
  it.each([
    ['Claude Code, with its zone', 'claude hit its usage limit: You\'ve hit your limit · resets 3pm (Europe/Madrid)', '2026-11-08T14:00:00Z'],
    ['Claude Code, an hour already past today', 'You\'ve hit your limit · resets 1pm (Europe/Madrid)', '2026-11-09T12:00:00Z'],
    ['Claude Code\'s 5-hour window, in the member\'s zone', '5-hour limit reached ∙ resets 2pm', '2026-11-08T13:00:00Z'],
    ['Claude Code\'s weekly limit, with a date', 'You\'ve hit your weekly limit · resets Nov 12, 9am (Europe/Madrid)', '2026-11-12T08:00:00Z'],
    ['Claude Code\'s weekly limit, with minutes', 'You\'ve hit your weekly limit · resets Nov 12 at 9:30am (America/New_York)', '2026-11-12T14:30:00Z'],
    ['older Claude Code, by epoch seconds', 'Claude AI usage limit reached|1794150000', '2026-11-08T15:00:00Z'],
    ['Codex, at a time', 'You\'ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), or try again at 3:04 PM.', '2026-11-08T14:04:00Z'],
    ['Codex, at a date and time', 'You\'ve hit your usage limit. Upgrade to Plus to continue using Codex, or try again at Nov 13th, 2026 4:02 PM.', '2026-11-13T15:02:00Z'],
    ['Codex, after a while', 'You\'ve hit your usage limit. Try again in 2 days 3 hours 4 minutes.', '2026-11-10T15:34:00Z'],
  ])('reads %s', (_case, text, expected) => {
    expect(UsageLimits.resetOf(text, { now, zone })).toBe(Date.parse(expected));
  });

  // New York leaves daylight time at 2am on Sunday, Nov 1, 2026: noon on the Saturday is 16:00 UTC, 9am on the Sunday 14:00 UTC.
  it.each([
    ['a reset the next morning', 'You\'ve hit your limit · resets 9am (America/New_York)', '2026-11-01T14:00:00Z'],
    ['a dated reset', 'You\'ve hit your weekly limit · resets Nov 1, 9am (America/New_York)', '2026-11-01T14:00:00Z'],
  ])('reads %s across a daylight saving change', (_case, text, expected) => {
    expect(UsageLimits.resetOf(text, { now: Date.parse('2026-10-31T16:00:00Z'), zone })).toBe(Date.parse(expected));
  });

  it.each([
    ['an API rate limit', 'claude hit its usage limit: API Error: Request rejected (429) · Rate limit exceeded'],
    ['OpenCode\'s free limit', 'opencode hit its usage limit: Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.'],
    ['an unknown zone', 'You\'ve hit your limit · resets 3pm (Mars/Olympus)'],
  ])('reads no reset from %s', (_case, text) => {
    expect(UsageLimits.resetOf(text, { now, zone })).toBeUndefined();
  });
});

describe('usage limits of one drive', () => {
  const hour = 3_600_000;

  it('holds a tool until its reset, and only that tool', () => {
    const limits = UsageLimits.open({ capMs: 6 * hour, zone });
    limits.hit({ tool: 'claude', message: 'claude hit its usage limit: You\'ve hit your limit · resets 3pm (Europe/Madrid)', now });

    expect(limits.held(now)).toEqual({ claude: 'claude hit its usage limit, which resets at 15:00 (Europe/Madrid)' });
    expect(limits.held(Date.parse('2026-11-08T14:01:00Z'))).toEqual({});
  });

  it('waits for a reset within the cap, and gives up on one past it', () => {
    const limits = UsageLimits.open({ capMs: 6 * hour, zone });
    limits.hit({ tool: 'claude', message: 'You\'ve hit your limit · resets 3pm (Europe/Madrid)', now });
    limits.hit({ tool: 'codex', message: 'You\'ve hit your usage limit. Try again in 2 days 3 hours 4 minutes.', now });

    expect(limits.whenIdle(now, ['claude'])).toEqual({ kind: 'wait', tool: 'claude', until: Date.parse('2026-11-08T14:00:00Z'), reason: 'claude hit its usage limit, which resets at 15:00 (Europe/Madrid)' });
    expect(limits.whenIdle(now, ['claude', 'codex'])).toEqual({ kind: 'past_cap', tool: 'codex', reason: 'codex hit its usage limit, which resets at 2026-11-10 16:34 (Europe/Madrid), past the 6 hours an unattended run waits for it' });
  });

  it('tries a limit that gives no reset again, a little later each time, until the cap passes', () => {
    const limits = UsageLimits.open({ capMs: 6 * hour, zone });
    const message = 'claude hit its usage limit: API Error: Request rejected (429)';
    limits.hit({ tool: 'claude', message, now });

    expect(limits.whenIdle(now, ['claude'])).toMatchObject({ kind: 'wait', until: now + 60_000 });
    limits.hit({ tool: 'claude', message, now: now + 60_000 });
    expect(limits.whenIdle(now + 60_000, ['claude'])).toMatchObject({ kind: 'wait', until: now + 180_000 });
    expect(limits.whenIdle(now + 6 * hour, ['claude'])).toEqual({ kind: 'past_cap', tool: 'claude', reason: 'claude hit its usage limit at 13:30 (Europe/Madrid) and gave no reset time, and it held for the 6 hours an unattended run waits for it' });
  });

  it('tries a limit whose given reset is already past again a little later, not at once, a little later each time', () => {
    const limits = UsageLimits.open({ capMs: 6 * hour, zone });
    // The older Claude Code form, an epoch a minute past: the server still refuses for a while after it.
    const message = `Claude AI usage limit reached|${(now - 60_000) / 1000}`;
    limits.hit({ tool: 'claude', message, now });

    expect(limits.whenIdle(now, ['claude'])).toMatchObject({ kind: 'wait', until: now + 60_000 });
    expect(limits.held(now)).toEqual({ claude: 'claude hit its usage limit, which it said resets at 13:29 (Europe/Madrid), already past, so teamai tries it again at 13:31 (Europe/Madrid)' });
    limits.hit({ tool: 'claude', message, now: now + 60_000 });
    expect(limits.whenIdle(now + 60_000, ['claude'])).toMatchObject({ kind: 'wait', until: now + 180_000 });
    expect(limits.whenIdle(now + 6 * hour, ['claude'])).toEqual({ kind: 'past_cap', tool: 'claude', reason: 'claude hit its usage limit at 13:30 (Europe/Madrid) and still held past the reset it gave, for the 6 hours an unattended run waits for it' });
  });

  it('holds a tool a fleet member met the limit of on the fleet only, where a limit met here holds it on the fleet within the cap', () => {
    const limits = UsageLimits.open({ capMs: 6 * hour, zone });
    limits.hit({ tool: 'claude', message: 'claude hit its usage limit: You\'ve hit your limit · resets 3pm (Europe/Madrid)', now, on: 'fleet' });

    // The member signed in with its own account: this machine's claude is not held.
    expect(limits.held(now)).toEqual({});
    expect(limits.heldOnFleet(now)).toEqual({ claude: 'claude hit its usage limit, which resets at 15:00 (Europe/Madrid)' });
    expect(limits.whenIdle(now, ['claude'])).toMatchObject({ kind: 'wait', tool: 'claude', until: Date.parse('2026-11-08T14:00:00Z') });
    limits.ran('claude', now + 1000, 'fleet');
    expect(limits.heldOnFleet(now + 2000)).toEqual({});

    limits.hit({ tool: 'codex', message: 'You\'ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), or try again at 3:04 PM.', now });
    expect(limits.held(now)).toEqual({ codex: 'codex hit its usage limit, which resets at 15:04 (Europe/Madrid)' });
    expect(limits.heldOnFleet(now)).toEqual({ codex: 'codex hit its usage limit, which resets at 15:04 (Europe/Madrid)' });
  });

  it('keeps a limit when a step that launched before it hit ends well', () => {
    const limits = UsageLimits.open({ capMs: hour, zone });
    limits.hit({ tool: 'claude', message: 'You\'ve hit your limit · resets 3pm (Europe/Madrid)', now });
    limits.ran('claude', now - 1000);

    expect(limits.held(now)).toEqual({ claude: 'claude hit its usage limit, which resets at 15:00 (Europe/Madrid)' });
  });

  it('asks a person who attends once per row of limits, and waits past the cap once they chose to', () => {
    const limits = UsageLimits.open({ capMs: hour, zone });
    const message = 'claude hit its usage limit: API Error: Request rejected (429)';
    limits.hit({ tool: 'claude', message, now });

    expect(limits.whenIdle(now, ['claude'], { attended: true })).toMatchObject({ kind: 'ask', tool: 'claude', until: now + 60_000 });
    limits.choseWait('claude');
    expect(limits.whenIdle(now + 2 * hour, ['claude'], { attended: true })).toMatchObject({ kind: 'wait', tool: 'claude' });
    limits.hit({ tool: 'claude', message, now: now + 2 * hour });
    expect(limits.whenIdle(now + 2 * hour, ['claude'], { attended: true })).toMatchObject({ kind: 'wait', tool: 'claude' });
    limits.ran('claude', now + 3 * hour);
    limits.hit({ tool: 'claude', message, now: now + 4 * hour });
    expect(limits.whenIdle(now + 4 * hour, ['claude'], { attended: true })).toMatchObject({ kind: 'ask', tool: 'claude' });
  });

  it('starts the cap again once a launch on the tool ends without the limit', () => {
    const limits = UsageLimits.open({ capMs: hour, zone });
    const message = 'claude hit its usage limit: API Error: Request rejected (429)';
    limits.hit({ tool: 'claude', message, now });
    limits.ran('claude', now + 1);
    limits.hit({ tool: 'claude', message, now: now + hour });

    expect(limits.whenIdle(now + hour, ['claude'])).toMatchObject({ kind: 'wait', until: now + hour + 60_000 });
  });
});

describe('a reset time without a zone, printed on a step runtime', () => {
  it('reads as the instant the limit resets when the runtime\'s own zone is not the member\'s', () => {
    const member = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const wallOf = (zoned: string, at: number): string => new Intl.DateTimeFormat('en-US', { timeZone: zoned, hour: 'numeric', minute: 'numeric' }).format(at);
    const at = Math.floor(Date.now() / 60_000) * 60_000;
    // A container runs in a zone of its own, UTC unless told otherwise: here one whose clock is not the member's.
    const runtimeZone = ['Asia/Tokyo', 'America/New_York'].find((each) => wallOf(each, at) !== wallOf(member, at))!;
    const resetsAt = at + 2 * 3_600_000;
    const config: LocalConfig = { repo: { localPath: '/team', remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: '/work', dataHome: '/data' };
    const step = runtimeStepEnv({ attempt: AttemptIdSchema.parse('a0c1d2e3f') }, {}, { config, run: RunIdSchema.parse('r0c1d2e3f'), mode: 'unattended' });

    // The tool prints its reset as Codex does, in the zone of the process the runtime starts with the step's env.
    const printed = execFileSync(process.execPath, ['-e', [
      'const at = new Date(Number(process.argv[1]));',
      'const hour = at.getHours();',
      "console.log(`try again at ${hour % 12 || 12}:${String(at.getMinutes()).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`);",
    ].join(' '), String(resetsAt)], { env: { PATH: process.env.PATH, TZ: runtimeZone, ...step.env }, encoding: 'utf8' }).trim();
    const limits = UsageLimits.open();
    limits.hit({ tool: 'codex', message: `You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), or ${printed}.`, now: at });

    expect(limits.whenIdle(at, ['codex'])).toMatchObject({ kind: 'wait', until: resetsAt });
  });
});
