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

const PASS = /^[1-9][0-9]*$/;

/** `text` cut at its first `:`, when both sides hold something. */
function head(text: string): [string, string] | undefined {
  const at = text.indexOf(':');

  return at > 0 && at < text.length - 1 ? [text.slice(0, at), text.slice(at + 1)] : undefined;
}

function parsed(text: string): Subject | undefined {
  const [kind, rest] = head(text) ?? [];
  const [first, last] = rest === undefined ? [] : head(rest) ?? [];

  if (first === undefined || last === undefined) return undefined;

  switch (kind) {
    case 'session':
      return { kind, subject: { platform: first, sessionId: last } };
    case 'team-session':
      return { kind, subject: { author: first, name: last } };
    case 'run': {
      const at = last.lastIndexOf(':');
      const pass = Number(last.slice(at + 1));

      return at > 0 && PASS.test(last.slice(at + 1)) && Number.isSafeInteger(pass) ? { kind, subject: { runId: first, step: last.slice(0, at), pass } } : undefined;
    }

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
