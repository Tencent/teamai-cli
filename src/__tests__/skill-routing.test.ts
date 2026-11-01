import { describe, expect, it } from 'vitest';
import type { AvailableSkill } from '../scorers/skill-evidence.js';
import { ROUTING_PREFIX, isRoutingScorer, parseRoutingScorer, routingScorer, routingScorerName, routingScorers, routingSkillOf } from '../scorers/skill-routing.js';
import { scorerSourceHash } from '../scorers/cache.js';

const skill = (name: string, extra: Partial<AvailableSkill> = {}): AvailableSkill => ({ name, ...extra });
const release: AvailableSkill = { name: 'release', namespace: 'ops', description: 'Cut an npm release: bump, changelog, tag, publish.' };
const reviewNotes: AvailableSkill = { name: 'review-notes', description: 'Write review notes for a PR.' };

describe('routing question names (#1469)', () => {
  it('names a root skill without a namespace and a namespaced one with it', () => {
    expect(routingScorerName(reviewNotes)).toBe(`${ROUTING_PREFIX}review-notes`);
    expect(routingScorerName(release)).toBe(`${ROUTING_PREFIX}ops:release`);
  });

  it('parses the names it generates, and nothing else', () => {
    expect(parseRoutingScorer('teamai:routing:review-notes')).toEqual({ skill: 'review-notes' });
    expect(parseRoutingScorer('teamai:routing:ops:release')).toEqual({ namespace: 'ops', skill: 'release' });
    expect(parseRoutingScorer('teamai:routing:')).toBeUndefined();
    expect(parseRoutingScorer('teamai:routing::release')).toBeUndefined();
    expect(parseRoutingScorer('teamai:routing:ops:release:extra')).toBeUndefined();
    expect(parseRoutingScorer('quality')).toBeUndefined();
    expect(isRoutingScorer('teamai:routing:ops:release')).toBe(true);
    expect(isRoutingScorer('scorers/quality.md')).toBe(false);
  });

  it('finds the skill a name judges by name and namespace together', () => {
    const available = [release, skill('release'), reviewNotes];
    expect(routingSkillOf({ skill: 'release', namespace: 'ops' }, available)).toBe(release);
    expect(routingSkillOf({ skill: 'release' }, available)).toBe(available[1]);
    expect(routingSkillOf({ skill: 'release', namespace: 'sre' }, available)).toBeUndefined();
    expect(routingSkillOf({ skill: 'absent' }, available)).toBeUndefined();
  });

  it('never names a skill whose namespace the record cannot tell, on demand either', () => {
    const unknown: AvailableSkill = { name: 'legacy', namespaceUnknown: true, description: 'which namespace?' };
    expect(routingSkillOf({ skill: 'legacy' }, [unknown, reviewNotes])).toBeUndefined();
    expect(routingSkillOf({ skill: 'legacy', namespace: 'ops' }, [unknown])).toBeUndefined();
  });
});

describe('a routing question rubric (#1469)', () => {
  it('parses to the four labels of the shared rubric, with the skill named in each', () => {
    const { scorer, pin, definition } = routingScorer(release);
    expect(scorer).toBe('teamai:routing:ops:release');
    expect(pin.content).toContain('Judge only the team skill `release`, against its entry in `skills.available` in evidence.json.');
    expect(pin.content).toContain('It comes from the `ops` skills namespace.');
    expect(definition.name).toBe(scorer);
    expect(definition.passingScore).toBe(1);
    expect(definition.labels.map(({ value, score }) => [value, score])).toEqual([['fit', 1], ['idle', 1], ['extra', 0], ['missed', 0]]);
    // The judge reads the description in evidence.json, never in the rubric.
    expect(pin.content).not.toContain('bump, changelog');
  });

  it('hashes the rubric the same however the description is rewritten', () => {
    const before = routingScorer(release);
    const after = routingScorer({ ...release, description: 'Cut a release.' });
    expect(after.pin.sourceHash).toBe(before.pin.sourceHash);
    expect(scorerSourceHash(before.pin.content)).toBe(before.pin.sourceHash);
    // A teamai release that changes the rubric changes the hash: a different skill name is a different rubric.
    expect(routingScorer(reviewNotes).pin.sourceHash).not.toBe(before.pin.sourceHash);
  });

  it('asks one question per skill whose namespace the record can tell, and none for namespaceUnknown', () => {
    const unknown: AvailableSkill = { name: 'legacy', namespaceUnknown: true, description: 'which namespace?' };
    expect(routingScorers([release, reviewNotes, unknown]).map(({ scorer }) => scorer)).toEqual(['teamai:routing:ops:release', 'teamai:routing:review-notes']);
  });
});
