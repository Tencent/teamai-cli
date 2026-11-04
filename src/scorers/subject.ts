/**
 * What one `teamai-score` run labels, as the text its `subject` input carries: `run:<runId>:<step path>:<pass>`,
 * `session:<source>:<sessionId>` or `team-session:<author>:<archive name>`. Every part before the last ends at its first
 * `:`, so a step path, a session id or an archive name may hold `:`.
 */
import type { RunSubject, SessionSubject } from './label.js';

/** A session another member pushed to the team archive, by who pushed it and the name it was pushed under. */
export interface TeamSessionSubject {
  author: string;
  name: string;
}

export type Subject =
  | { kind: 'run'; subject: RunSubject }
  | { kind: 'session'; subject: SessionSubject }
  | { kind: 'team-session'; subject: TeamSessionSubject };

/** A kind, then a part up to the first `:`, then the rest; neither part empty. */
const PARTS = /^(run|session|team-session):([^:]+):(.+)$/su;

/** A run's step path up to its last `:`, then a pass from 1. */
const STEP_PASS = /^(.+):([1-9][0-9]*)$/su;

function runOf(runId: string, rest: string): Subject | undefined {
  const [, step, digits] = STEP_PASS.exec(rest) ?? [];
  const pass = Number(digits);

  return step !== undefined && Number.isSafeInteger(pass) ? { kind: 'run', subject: { runId, step, pass } } : undefined;
}

function parsed(text: string): Subject | undefined {
  const [, kind, first = '', rest = ''] = PARTS.exec(text) ?? [];

  switch (kind) {
    case 'session':
      return { kind, subject: { platform: first, sessionId: rest } };
    case 'team-session':
      return { kind, subject: { author: first, name: rest } };
    case 'run':
      return runOf(first, rest);
    default:
      return undefined;
  }
}

export const Subject = {
  parse(text: string): { ok: true; subject: Subject } | { ok: false; code: 'subject_invalid'; message: string } {
    const subject = parsed(text);

    if (subject) return { ok: true, subject };

    return {
      ok: false,
      code: 'subject_invalid',
      message: `${JSON.stringify(text)} is not a subject. Pass run:<runId>:<step path>:<pass> with a pass from 1, session:<source>:<sessionId>, or team-session:<author>:<archive name>.`,
    };
  },

  format(subject: Subject): string {
    switch (subject.kind) {
      case 'run':
        return `run:${subject.subject.runId}:${subject.subject.step}:${subject.subject.pass}`;
      case 'session':
        return `session:${subject.subject.platform}:${subject.subject.sessionId}`;
      case 'team-session':
        return `team-session:${subject.subject.author}:${subject.subject.name}`;
      default: {
        const unhandled: never = subject;

        return unhandled;
      }
    }
  },
} as const;
