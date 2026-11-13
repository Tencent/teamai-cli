import { describe, expect, it } from 'vitest';
import { InheritedFolders } from '../resources/inherited-folders.js';

const files = (...paths: string[]) => paths.map((path) => ({ path }));
const TEAMAI = files('HOOK.yaml', 'README.md', 'gap.md', 'problem.md', 'problem.zh.md', 'prompts/plan.en.md', 'prompts/plan.md');

describe('a team folder over the teamai default of its name', () => {
  it.each<{ case: string; team: string[]; layers: Record<string, 'team' | 'teamai'>; strays?: string[] }>([
    {
      case: 'keeps every file the team leaves out, the marker included',
      team: ['problem.md'],
      layers: { 'HOOK.yaml': 'teamai', 'README.md': 'teamai', 'gap.md': 'teamai', 'problem.md': 'team', 'prompts/plan.en.md': 'teamai', 'prompts/plan.md': 'teamai' },
    },
    {
      case: 'replaces every language of a text the team writes in one language',
      team: ['problem.zh.md'],
      layers: { 'HOOK.yaml': 'teamai', 'README.md': 'teamai', 'gap.md': 'teamai', 'problem.zh.md': 'team', 'prompts/plan.en.md': 'teamai', 'prompts/plan.md': 'teamai' },
    },
    {
      case: 'replaces a file in a subdirectory with its languages',
      team: ['prompts/plan.md'],
      layers: { 'HOOK.yaml': 'teamai', 'README.md': 'teamai', 'gap.md': 'teamai', 'problem.md': 'teamai', 'problem.zh.md': 'teamai', 'prompts/plan.md': 'team' },
    },
    {
      case: 'leaves out a file that replaces nothing, and names it',
      team: ['problems.md', 'gap.md'],
      layers: { 'HOOK.yaml': 'teamai', 'README.md': 'teamai', 'gap.md': 'team', 'problem.md': 'teamai', 'problem.zh.md': 'teamai', 'prompts/plan.en.md': 'teamai', 'prompts/plan.md': 'teamai' },
      strays: ['problems.md'],
    },
    {
      case: 'keeps a file teamai lacks when the team replaces the marker, which may name it',
      team: ['HOOK.yaml', 'extra.md'],
      layers: { 'HOOK.yaml': 'team', 'README.md': 'teamai', 'extra.md': 'team', 'gap.md': 'teamai', 'problem.md': 'teamai', 'problem.zh.md': 'teamai', 'prompts/plan.en.md': 'teamai', 'prompts/plan.md': 'teamai' },
    },
    {
      case: 'reads a dotted name that is no language as a file of its own',
      team: ['problem.old.md'],
      layers: { 'HOOK.yaml': 'teamai', 'README.md': 'teamai', 'gap.md': 'teamai', 'problem.md': 'teamai', 'problem.zh.md': 'teamai', 'prompts/plan.en.md': 'teamai', 'prompts/plan.md': 'teamai' },
      strays: ['problem.old.md'],
    },
  ])('$case', ({ team, layers, strays = [] }) => {
    const merged = InheritedFolders.merge({ team: files(...team), teamai: TEAMAI, marker: 'HOOK.yaml' });

    // In path order, as list --json and the dashboard show them.
    expect({ layers: merged.files.map((file) => [file.path, file.layer]), strays: merged.strays }).toEqual({ layers: Object.entries(layers), strays });
  });

  it.each<{ case: string; team: string[]; inherited: string[] | null }>([
    { case: 'took nothing when the team replaces every file', team: ['HOOK.yaml', 'README.md', 'gap.md', 'problem.md', 'prompts/plan.md'], inherited: null },
    { case: 'took the text the team leaves out, in each language', team: ['HOOK.yaml', 'README.md', 'gap.md', 'problem.md'], inherited: ['prompts/plan.en.md', 'prompts/plan.md'] },
  ])('says the folder $case', ({ team, inherited }) => {
    const merged = InheritedFolders.merge({ team: files(...team), teamai: TEAMAI, marker: 'HOOK.yaml' });

    expect(InheritedFolders.inheritanceOf(merged, '1.2.3')).toEqual(inherited === null ? null : { teamaiVersion: '1.2.3', files: inherited });
  });
});
