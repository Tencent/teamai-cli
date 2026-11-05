/**
 * Adoption questions (#1391): one generated scorer per recalled doc a finished session never opened, named
 * `teamai:adoption:<hash>` after the doc's vote key. A read credits a doc it opened with no judge; a question asks
 * whether the session adopted one it did not, such as one a subagent's summary carried. The rubric is teamai's default
 * scorer `scorers/teamai-adoption.md`, which a team replaces with a file of that name, filled in with `doc.id`,
 * `doc.path` and `doc.file`. The doc's text, as the session was given it, is pinned with the question and written to
 * `recalled/<doc.file>` in the evidence.
 *
 * A passing label upvotes the doc and a failing one counts it judged, once per root session and doc (recall-adoption.ts).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DefaultScorers } from '../default-scorers.js';
import { adoptionCandidates, creditAdoptionVerdicts, recalledDocsForSession } from '../recall-adoption.js';
import type { RecalledDoc } from '../recall-log.js';
import type { LocalConfig } from '../types.js';
import { knowledgeRoots } from '../utils/learnings-roots.js';
import { log } from '../utils/logger.js';
import { defaultScorerRubric, scorerSourceHash } from './cache.js';
import type { GeneratedQuestion, QuestionFamily, QuestionLookup } from './generated-questions.js';

const ADOPTION_PREFIX = 'teamai:adoption:';

/** The most of a recalled doc a judge reads. */
const MAX_DOC_CHARS = 1_200;

function hashOf(doc: string): string {
  return createHash('sha256').update(doc).digest('hex').slice(0, 12);
}

/** The adoption question's name of the doc kept under vote key `doc`. */
export function adoptionScorerName(doc: string): string {
  return `${ADOPTION_PREFIX}${hashOf(doc)}`;
}

/** Whether canonical `child` is one of canonical `roots` or lies under one; `/a/team-evil` is not under `/a/team`. */
function isUnderRoot(child: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const rel = path.relative(root, child);

    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

/**
 * The start of the doc at `filePath`, or '' when it is not one a judge may read. The path comes from the recall log,
 * which the session's own tool calls fed, so it is read only as a regular `.md` file, no symlink, whose real path lies
 * in one of `roots`, the canonical knowledge roots; none refuses every read.
 */
function excerptOf(filePath: string, roots: readonly string[]): { path: string; text: string } | undefined {
  try {
    if (roots.length === 0 || !/\.md$/i.test(filePath)) return undefined;
    const link = fs.lstatSync(filePath);

    if (link.isSymbolicLink() || !link.isFile()) return undefined;
    const real = fs.realpathSync(filePath);

    if (!/\.md$/i.test(real) || !fs.statSync(real).isFile() || !isUnderRoot(real, roots)) return undefined;
    const raw = fs.readFileSync(real, 'utf8');
    const text = raw.length > MAX_DOC_CHARS ? `${raw.slice(0, MAX_DOC_CHARS)}\n…[truncated]` : raw;

    return text.trim() === '' ? undefined : { path: real, text };
  } catch {
    return undefined;
  }
}

/** The knowledge roots of `config`, canonical; one that cannot be resolved is left out. */
async function canonicalRoots(config: LocalConfig): Promise<string[]> {
  return (await knowledgeRoots(config)).flatMap((root) => {
    try {
      return [fs.realpathSync(root)];
    } catch {
      return [];
    }
  });
}

/** The question of `doc`, whose text `excerpt` is, with `rubric` filled in; `doc.path` is relative to the root it lies under. */
function questionOf(rubric: string, doc: RecalledDoc, excerpt: { path: string; text: string }, roots: readonly string[]): GeneratedQuestion {
  const scorer = adoptionScorerName(doc.key);
  const file = `${hashOf(doc.key)}.md`;
  const root = roots.find((each) => isUnderRoot(excerpt.path, [each]));
  const values = { 'doc.id': doc.key, 'doc.path': root === undefined ? doc.path : path.relative(root, excerpt.path).split(path.sep).join('/'), 'doc.file': file };
  const { content, definition } = DefaultScorers.fillIn('teamai-adoption', { file: `scorers/${scorer.replaceAll(':', '-')}.md`, content: rubric }, values);

  return { scorer, pin: { sourceHash: scorerSourceHash(content), content, variables: values, evidence: { [`recalled/${file}`]: excerpt.text } }, definition: { ...definition, name: scorer } };
}

/** The questions of `docs` a judge can ground: each doc's text is readable under the knowledge roots. */
async function groundedQuestions(config: LocalConfig, docs: readonly RecalledDoc[]): Promise<GeneratedQuestion[]> {
  if (docs.length === 0) return [];
  const roots = await canonicalRoots(config);
  const { content: rubric } = await defaultScorerRubric(config, 'teamai-adoption');

  return docs.flatMap((doc) => {
    const excerpt = excerptOf(doc.path, roots);

    return excerpt ? [questionOf(rubric, doc, excerpt, roots)] : [];
  });
}

/** The adoption family of generated questions, while `recall_adoption` is on. */
export const adoptionQuestions: QuestionFamily = {
  prefix: ADOPTION_PREFIX,
  noun: 'adoption question',
  switch: 'recallAdoption',

  async questions(config, { subject }) {
    return groundedQuestions(config, await adoptionCandidates(config, subject.sessionId));
  },

  // Named on demand, a doc the session opened or was credited for is still judged; its label credits nothing again.
  async questionOf(config, name, session): Promise<QuestionLookup> {
    const docs = session === undefined ? [] : await recalledDocsForSession(config, session.subject.sessionId);
    const doc = docs.find(({ key }) => adoptionScorerName(key) === name);

    if (doc === undefined) {
      const names = docs.map(({ key }) => `${adoptionScorerName(key)} (${key})`);

      return { ok: false, why: names.length === 0 ? 'The session recalled no team doc this scope keeps votes for.' : `It names no doc the session recalled: ${names.join(', ')}.` };
    }

    const [question] = await groundedQuestions(config, [doc]);

    return question ? { ok: true, question } : { ok: false, why: `${doc.key} cannot be read under the knowledge roots, so a judge could not ground a verdict on it.` };
  },

  async written(config, subject, labels) {
    const verdicts = labels.flatMap(({ pin, passed }) => {
      const doc = pin.variables?.['doc.id'];

      return doc === undefined ? [] : [{ doc, adopted: passed }];
    });

    if (await creditAdoptionVerdicts(config, subject.sessionId, verdicts) === null) {
      log.info('The votes file is busy, so the adoption credit waits: the next teamai score or teamai pull writes it.');
    }
  },
};
