/**
 * The questions teamai generates for a finished session, one per item of a family: a routing question per team skill
 * its captures delivered (#1469), an adoption question per recalled doc it never opened (#1391). Each is a scorer of the
 * session judged by `teamai-score` like a team's, named `teamai:<family>:<item>`, a name no scorer file may have. Its
 * rubric is a default scorer a team replaces (`src/default-scorers.ts`), filled in with the item.
 *
 * A family says which scoring switch asks its questions automatically, which questions a session has, which one a name
 * names, and, optionally, what a written label of one does: an adoption label credits the doc's votes. Code outside the
 * families never branches on one.
 */
import type { SessionCapture } from '../session-flow/captures.js';
import type { LocalConfig } from '../types.js';
import type { ScorerDefinition } from './definition.js';
import type { SessionSubject } from './label.js';
import type { PinnedScorer } from './pin.js';
import type { ScopeScoring } from './settings.js';
import { adoptionQuestions } from './adoption.js';
import { routingQuestions } from './skill-routing.js';

/** A session a family asks of: its subject, and the captures its hooks recorded here. */
export interface QuestionSession {
  subject: SessionSubject;
  captures: readonly SessionCapture[];
}

/** A generated question: its scorer name, its pinned rubric, and the definition the rubric parses to. */
export interface GeneratedQuestion {
  scorer: string;
  pin: PinnedScorer;
  definition: ScorerDefinition;
}

export type QuestionLookup = { ok: true; question: GeneratedQuestion } | { ok: false; why: string };

/** A label `teamai score write` stored for a generated question: the question's pin, and whether it passed. */
export interface WrittenQuestionLabel {
  scorer: string;
  pin: PinnedScorer;
  passed: boolean;
}

/** The scoring switches of a scope that ask a family's questions automatically. */
export type QuestionSwitches = Pick<Extract<ScopeScoring, { ok: true }>, 'skillRouting' | 'recallAdoption'>;

export interface QuestionFamily {
  /** `teamai:<family>:`, which every question name of the family starts with. */
  prefix: string;
  /** What a refusal calls one of its questions, such as `routing question`. */
  noun: string;
  switch: keyof QuestionSwitches;
  /** Every question of `session`, in the order its items came. */
  questions(config: LocalConfig, session: QuestionSession): Promise<GeneratedQuestion[]>;
  /** The question `name` names on `session`, whatever the switch says, or why it names none; undefined: a session with no captures here. */
  questionOf(config: LocalConfig, name: string, session: QuestionSession | undefined): Promise<QuestionLookup>;
  /** What the labels written of the family's questions on `subject` do beyond being stored. */
  written?(config: LocalConfig, subject: SessionSubject, labels: readonly WrittenQuestionLabel[]): Promise<void>;
}

const FAMILIES: readonly QuestionFamily[] = [routingQuestions, adoptionQuestions];

function familyOf(name: string): QuestionFamily | undefined {
  return FAMILIES.find((family) => name.startsWith(family.prefix));
}

export const GeneratedQuestions = {
  /** Whether `name` names a generated question, rather than a scorer of the team. */
  isGenerated(name: string): boolean {
    return familyOf(name) !== undefined;
  },

  /** The family `name` is a question of, which questions sharing a judge group by; undefined for a team scorer. */
  familyOf(name: string): Pick<QuestionFamily, 'prefix' | 'noun'> | undefined {
    return familyOf(name);
  },

  /** Every question of `session` its scope's switches ask automatically; none for a session with no captures here. */
  async questions(config: LocalConfig, session: QuestionSession | undefined, switches: QuestionSwitches): Promise<GeneratedQuestion[]> {
    if (session === undefined) return [];
    const asked = FAMILIES.filter((family) => switches[family.switch]);

    return (await Promise.all(asked.map((family) => family.questions(config, session)))).flat();
  },

  /** The question `name` names on `session`, or why it names none. */
  async questionOf(config: LocalConfig, name: string, session: QuestionSession | undefined): Promise<QuestionLookup> {
    const family = familyOf(name);

    return family ? family.questionOf(config, name, session) : { ok: false, why: `${name} is no question teamai generates.` };
  },

  /** Lets each family act on the labels just written of its questions on `subject`. */
  async written(config: LocalConfig, subject: SessionSubject, labels: readonly WrittenQuestionLabel[]): Promise<void> {
    for (const family of FAMILIES) {
      const own = labels.filter((label) => label.scorer.startsWith(family.prefix));

      if (own.length > 0 && family.written) await family.written(config, subject, own);
    }
  },
} as const;
