import { describe, expect, it } from 'vitest';
import { formatScorerDiagnostic, parseScorer } from '../scorers/definition.js';

const VALID = `---
labels:
  - value: good
    score: 1
    description: The change does what the step asked.
  - value: bad
    score: 0
    description: The change misses the request.
passingScore: 1
---
Judge whether the change does what the step asked.
`;

function scorerWith(frontmatter: string, body = 'Judge the change.\n'): string {
  return `---\n${frontmatter}---\n${body}`;
}

const LABELS = `labels:
  - { value: good, score: 1, description: Good. }
  - { value: bad, score: 0, description: Bad. }
`;

const COUNT = 'must list 2 to 20 labels: at least one that passes and one that fails';

function problems(file: string, content: string): string[] {
  const parsed = parseScorer(file, content);
  return parsed.ok ? [] : parsed.diagnostics.map(formatScorerDiagnostic);
}

describe('parseScorer', () => {
  it('reads labels, passing score and prompt, with a sampling rate of 25 by default', () => {
    expect(parseScorer('scorers/review-quality.md', VALID)).toEqual({
      ok: true,
      definition: {
        name: 'review-quality',
        labels: [
          { value: 'good', score: 1, description: 'The change does what the step asked.' },
          { value: 'bad', score: 0, description: 'The change misses the request.' },
        ],
        passingScore: 1,
        samplingRate: 25,
        prompt: 'Judge whether the change does what the step asked.\n',
      },
    });
  });

  it('reads model, isolation and an explicit sampling rate', () => {
    const parsed = parseScorer('scorers/q.md', scorerWith(`${LABELS}passingScore: 1\nsamplingRate: 100\nmodel: fast\nisolation: verified\n`));
    expect(parsed.ok && parsed.definition).toMatchObject({ samplingRate: 100, model: 'fast', isolation: 'verified' });
  });

  it.each([
    ['no frontmatter', 'Just a prompt.\n', 'scorers/q.md: a scorer starts with YAML frontmatter between --- lines'],
    ['an empty prompt', scorerWith(`${LABELS}passingScore: 1\n`, '\n'), 'scorers/q.md: the prompt after the frontmatter is empty'],
    ['no labels', scorerWith('passingScore: 1\n'), `scorers/q.md: labels ${COUNT}`],
    ['one label', scorerWith('labels:\n  - { value: good, score: 1, description: Good. }\npassingScore: 1\n'), `scorers/q.md: labels ${COUNT}`],
    ['21 labels', scorerWith(`labels:\n${Array.from({ length: 21 }, (_, i) => `  - { value: l${i}, score: ${i}, description: D. }\n`).join('')}passingScore: 1\n`),
      `scorers/q.md: labels ${COUNT}`],
    ['a label without a score', scorerWith('labels:\n  - { value: good, description: Good. }\n  - { value: bad, score: 0, description: Bad. }\npassingScore: 1\n'),
      'scorers/q.md: labels[0].score must be a number'],
    ['a repeated label', scorerWith('labels:\n  - { value: good, score: 1, description: G. }\n  - { value: good, score: 0, description: B. }\npassingScore: 1\n'),
      'scorers/q.md: labels[1].value repeats "good"'],
    ['no label below the passing score', scorerWith(`${LABELS}passingScore: 0\n`),
      'scorers/q.md: passingScore must have at least one label at or above it and one below it'],
    ['no passing score', scorerWith(LABELS), 'scorers/q.md: passingScore must be a number'],
    ['a sampling rate over 100', scorerWith(`${LABELS}passingScore: 1\nsamplingRate: 101\n`), 'scorers/q.md: samplingRate must be a number from 0 to 100'],
    ['a model with spaces', scorerWith(`${LABELS}passingScore: 1\nmodel: two words\n`), 'scorers/q.md: model must be a non-empty string without spaces'],
    ['a model with a template', scorerWith(`${LABELS}passingScore: 1\nmodel: "{{inputs.judge}}"\n`), 'scorers/q.md: model cannot contain a template; write an alias or a model name as is'],
    ['an unknown isolation', scorerWith(`${LABELS}passingScore: 1\nisolation: strict\n`), 'scorers/q.md: isolation must be verified or best-effort'],
    ['an unknown key', scorerWith(`${LABELS}passingScore: 1\nthreshold: 2\n`),
      'scorers/q.md: uses `threshold`, which this teamai does not know. Update teamai.'],
  ])('rejects %s', (_case, content, problem) => {
    expect(problems('scorers/q.md', content)).toContain(problem);
  });

  it('rejects a file name that is not a token', () => {
    expect(problems('scorers/.hidden.md', VALID)).toEqual(['scorers/.hidden.md: the file name must be a token such as review-quality.md']);
  });
});
