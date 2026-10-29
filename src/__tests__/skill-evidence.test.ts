import { describe, expect, it } from 'vitest';
import { skillsEvidence } from '../scorers/skill-evidence.js';

const upper = (text: string): string => text.toUpperCase();
const same = (text: string): string => text;

describe('the skills a session is judged with (#1469)', () => {
  it('gives the skills_unknown gap when no capture recorded descriptions', () => {
    expect(skillsEvidence([{}, {}], ['review'], same)).toEqual({ gap: 'skills_unknown' });
  });

  it('gives an empty list and no gap when a capture recorded the checkout had no team skills', () => {
    expect(skillsEvidence([{ teamSkillInfo: {} }], [], same)).toEqual({ skills: { available: [], used: [] } });
  });

  it('lists each delivered skill with its namespace and masked description, a root skill without one, sorted by name', () => {
    const result = skillsEvidence([{
      teamSkillInfo: {
        'review-notes': { description: 'review a PR' },
        release: { namespace: 'ops', description: 'cut a release' },
      },
    }], ['review-notes'], upper);
    expect(result).toEqual({
      skills: {
        available: [
          { name: 'release', namespace: 'ops', description: 'CUT A RELEASE' },
          { name: 'review-notes', description: 'REVIEW A PR' },
        ],
        used: ['review-notes'],
      },
    });
  });

  it('unions skills across captures, the latest description of a name winning, oldest first', () => {
    const result = skillsEvidence([
      { teamSkillInfo: { release: { namespace: 'ops', description: 'old' } } },
      { teamSkillInfo: { release: { namespace: 'ops', description: 'new' }, deploy: { description: 'ship it' } } },
    ], ['deploy'], same);
    expect(result).toEqual({
      skills: {
        available: [
          { name: 'deploy', description: 'ship it' },
          { name: 'release', namespace: 'ops', description: 'new' },
        ],
        used: ['deploy'],
      },
    });
  });

  it('copies the used names it is given rather than aliasing them', () => {
    const used = ['a', 'b'];
    const result = skillsEvidence([{ teamSkillInfo: {} }], used, same);
    expect('skills' in result && result.skills.used).toEqual(['a', 'b']);
    expect('skills' in result && result.skills.used).not.toBe(used);
  });
});
