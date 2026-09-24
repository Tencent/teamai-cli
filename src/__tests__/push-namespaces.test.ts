import { describe, expect, it } from 'vitest';
import {
  isAtSharedRoot, isPlaceableType, placedResourcePath, resolveProjectNamespace, withNamespace,
} from '../push-namespaces.js';
import type { ProjectsManifest } from '../projects.js';
import type { ResourceItem } from '../types.js';

function item(type: ResourceItem['type'], name: string, relativePath: string): ResourceItem {
  return { name, type, sourcePath: `/local/${name}`, relativePath };
}

describe('isAtSharedRoot', () => {
  it('is true for a resource that carries no namespace directory', () => {
    expect(isAtSharedRoot(item('rules', 'my-rule', 'rules/my-rule.md'))).toBe(true);
    expect(isAtSharedRoot(item('agents', 'vr', 'agents/vr.yaml'))).toBe(true);
    expect(isAtSharedRoot(item('skills', 'my-skill', 'skills/my-skill'))).toBe(true);
  });

  it('is false once a namespace directory is present', () => {
    expect(isAtSharedRoot(item('rules', 'my-rule', 'rules/frontend/my-rule.md'))).toBe(false);
    expect(isAtSharedRoot(item('agents', 'vr', 'agents/frontend/vr.yaml'))).toBe(false);
    expect(isAtSharedRoot(item('skills', 'my-skill', 'skills/frontend/my-skill'))).toBe(false);
  });

  it('is false for a rule authored inside a subdirectory of the tool rules dir', () => {
    // `rules` names include their subdirectory (src/resources/rules.ts), so a
    // deeper path is already namespaced and must not be placed again.
    expect(isAtSharedRoot(item('rules', 'a/b/c', 'rules/a/b/c.md'))).toBe(false);
  });
});

describe('isPlaceableType', () => {
  it('accepts the namespaced types and rejects the rest', () => {
    expect(isPlaceableType('skills')).toBe(true);
    expect(isPlaceableType('rules')).toBe(true);
    expect(isPlaceableType('agents')).toBe(true);
    // env is pushable but never namespaced; docs and hooks are not placed either.
    expect(isPlaceableType('env')).toBe(false);
    expect(isPlaceableType('docs')).toBe(false);
    expect(isPlaceableType('hooks')).toBe(false);
  });
});

describe('withNamespace', () => {
  it('inserts the namespace after the resource root, keeping the basename', () => {
    expect(withNamespace('rules/my-rule.md', 'knowledge-ns')).toBe('rules/knowledge-ns/my-rule.md');
    expect(withNamespace('skills/my-skill', 'skills-ns')).toBe('skills/skills-ns/my-skill');
  });

  it('keeps an agent extension the caller does not know about', () => {
    // Agents push as .yaml, or .md on the legacy fallback path.
    expect(withNamespace('agents/vr.yaml', 'ns')).toBe('agents/ns/vr.yaml');
    expect(withNamespace('agents/vr.md', 'ns')).toBe('agents/ns/vr.md');
  });
});

const manifest: ProjectsManifest = {
  version: 1,
  projects: [
    {
      id: 'front-app',
      name: 'Front App',
      description: '',
      // Deliberately all different: the axis a type resolves from is the point.
      resources: { knowledge: ['fe-know'], skills: ['fe-skills'], learnings: [], agents: ['fe-agents'] },
    },
    {
      id: 'bare',
      name: 'Bare',
      description: '',
      resources: { knowledge: [], skills: ['bare-skills'], learnings: [], agents: [] },
    },
    {
      id: 'multi',
      name: 'Multi',
      description: '',
      resources: { knowledge: ['k1', 'k2'], skills: [], learnings: [], agents: [] },
    },
    {
      id: 'unsafe',
      name: 'Unsafe',
      description: '',
      // The manifest schema only requires a non-empty string.
      resources: { knowledge: ['../../evil'], skills: [], learnings: [], agents: [] },
    },
  ],
};

describe('resolveProjectNamespace', () => {
  it('resolves each type from its own axis', () => {
    expect(resolveProjectNamespace(manifest, 'front-app', 'rules')).toEqual({ ok: true, namespace: 'fe-know' });
    expect(resolveProjectNamespace(manifest, 'front-app', 'skills')).toEqual({ ok: true, namespace: 'fe-skills' });
    expect(resolveProjectNamespace(manifest, 'front-app', 'agents')).toEqual({ ok: true, namespace: 'fe-agents' });
  });

  it('fails naming the type and the axis when the project declares none', () => {
    const result = resolveProjectNamespace(manifest, 'bare', 'rules');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('rules');
    expect(result.ok === false && result.message).toContain('knowledge');
    expect(result.ok === false && result.message).toContain('bare');
  });

  it('fails rather than guessing when the axis is multi-valued', () => {
    const result = resolveProjectNamespace(manifest, 'multi', 'rules');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('k1, k2');
    expect(result.ok === false && result.message).toContain('--role');
  });

  it('rejects a namespace that is not a single safe path segment', () => {
    const result = resolveProjectNamespace(manifest, 'unsafe', 'rules');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('../../evil');
  });

  it('fails on an unknown project instead of throwing', () => {
    const result = resolveProjectNamespace(manifest, 'nope', 'rules');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/unknown project/i);
  });
});

/**
 * `state.json` is a file on disk, and both the push scanner and the pre-push
 * sync resolve a placement record through this one function. When only one of
 * them followed the record, the sync skipped a teammate's newer version and
 * the scan pushed the stale local copy over it.
 */
describe('placedResourcePath', () => {
  const rules = { 'my-rule': 'rules/fe-know/my-rule.md' };

  it('returns the recorded destination', () => {
    expect(placedResourcePath(rules, 'rules', 'my-rule')).toBe('rules/fe-know/my-rule.md');
  });

  it('returns null with no record at all', () => {
    expect(placedResourcePath(undefined, 'rules', 'my-rule')).toBeNull();
    expect(placedResourcePath({}, 'rules', 'my-rule')).toBeNull();
  });

  it('ignores a name that already carries its namespace', () => {
    // It matches its team file by full path and never needs a record.
    expect(placedResourcePath({ 'fe-know/my-rule': 'rules/fe-know/my-rule.md' }, 'rules', 'fe-know/my-rule'))
      .toBeNull();
  });

  it('rejects a record that escapes the resource root', () => {
    expect(placedResourcePath({ x: 'rules/../../etc/passwd' }, 'rules', 'x')).toBeNull();
    expect(placedResourcePath({ x: '../rules/ns/x.md' }, 'rules', 'x')).toBeNull();
    expect(placedResourcePath({ x: 'skills/ns/x.md' }, 'rules', 'x')).toBeNull();
  });

  it('rejects a namespace segment that is not a safe directory name', () => {
    // On Windows `path.join` reads the backslashes as separators, so this
    // escapes the resource root although it has three `/` segments (#649 review).
    expect(placedResourcePath({ foo: 'rules/..\\..\\victim/foo.md' }, 'rules', 'foo')).toBeNull();
    expect(placedResourcePath({ vr: 'agents/fe\\..\\..\\x/vr.yaml' }, 'agents', 'vr')).toBeNull();
    expect(placedResourcePath({ foo: 'rules/fe:ads/foo.md' }, 'rules', 'foo')).toBeNull();
  });

  it('rejects a record that is not namespaced or not named after the resource', () => {
    expect(placedResourcePath({ x: 'rules/x.md' }, 'rules', 'x')).toBeNull();
    expect(placedResourcePath({ x: 'rules/ns/sub/x.md' }, 'rules', 'x')).toBeNull();
    expect(placedResourcePath({ x: 'rules/ns/other.md' }, 'rules', 'x')).toBeNull();
  });

  it('requires the exact filename, not merely the resource name as a prefix', () => {
    // `x.backup.md` is somebody else's file. Trusting it would point scanning,
    // the pre-push sync and removal at an unrelated resource (#649 review).
    expect(placedResourcePath({ x: 'rules/ns/x.backup.md' }, 'rules', 'x')).toBeNull();
    expect(placedResourcePath({ x: 'rules/ns/x.yaml' }, 'rules', 'x')).toBeNull();
    expect(placedResourcePath({ vr: 'agents/ns/vr.old.yaml' }, 'agents', 'vr')).toBeNull();
    // A legacy `.md` agent is still the agent itself.
    expect(placedResourcePath({ vr: 'agents/ns/vr.md' }, 'agents', 'vr')).toBe('agents/ns/vr.md');
  });

  it('resolves an agent record, whose file keeps the canonical .yaml', () => {
    expect(placedResourcePath({ vr: 'agents/fe-agents/vr.yaml' }, 'agents', 'vr'))
      .toBe('agents/fe-agents/vr.yaml');
    expect(placedResourcePath({ vr: 'agents/fe-agents/vr.yaml' }, 'rules', 'vr')).toBeNull();
  });
});
