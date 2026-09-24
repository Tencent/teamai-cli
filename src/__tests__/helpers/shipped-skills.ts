import { createHash } from 'node:crypto';

/**
 * Stand-in content for "a file a release shipped", for tests that exercise the
 * legacy prune without the real historical blobs. Pair it with
 * `shippedSkillDigestsMock()` in a `vi.mock('../packaged-skill-digests.js')`:
 * a file holding `shipped(skill, path)` is the CLI's, anything else at the same
 * path is the member's.
 */
export function shipped(skill: string, relative: string, release: 1 | 2 = 1): string {
  return `# shipped ${skill}/${relative} (release ${release})\n`;
}

const PATHS: Readonly<Record<string, readonly string[]>> = {
  teamai: [
    'SKILL.md',
    'references/contribute-member.md',
    'references/join-member.md',
    'references/manage-admin.md',
    'references/provider-tgit.md',
    'references/setup-admin.md',
    'references/troubleshooting.md',
    'references/uninstall.md',
  ],
  'teamai-share-learnings': ['SKILL.md'],
  'team-wiki-codebase': [
    'SKILL.md',
    'README.md',
    'references/agents/graph-rag-agent.md',
    'references/agents/kb-doc-generator.md',
    'references/methodology/phase0-collection.md',
    'references/methodology/phase1-reverse-engineering.md',
    'references/methodology/phase2-document-types.md',
    'references/methodology/phase3-ai-enhancement.md',
    'references/methodology/phase4-quality.md',
    'references/templates/project-overview.md',
    'scripts/scan_repo.py',
    'scripts/validate_kb.py',
  ],
};

/** The module shape of `packaged-skill-digests.ts`: two shipped releases of every path. */
export function shippedSkillDigestsMock(): { PACKAGED_SKILL_DIGESTS: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>> } {
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
  return {
    PACKAGED_SKILL_DIGESTS: new Map(Object.entries(PATHS).map(([skill, paths]) => [
      skill,
      new Map(paths.map((relative) => [relative, [sha(shipped(skill, relative, 1)), sha(shipped(skill, relative, 2))]])),
    ])),
  };
}
