import crypto from 'node:crypto';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ModelProfileSchema,
  ModelProfilesFileSchema,
  getTeamIdentity,
  getTeamValuesPath,
  findTeamValuesPath,
  loadModelInputs,
  mergeModelInputs,
  profileAgents,
  profileRoutes,
  sameTeamIdentity,
  saveLocalProfiles,
  resolveProfile,
  resolveProfileRef,
  saveModelInputs,
  unadoptedLegacyFiles,
  isRepoReference,
  type ModelProfilesFile,
} from '../models/profile.js';
import type { LocalConfig } from '../types.js';

const TOKENHUB = {
  id: 'tokenhub',
  name: 'Tencent TokenHub',
  base_url: 'https://tokenhub.tencentmaas.com',
  api_key: '${API_KEY}',
  model_groups: [{ protocols: ['anthropic', 'openai-chat-completions'], models: ['glm-5.3', 'deepseek-v4-flash'] }],
};

function profile(id: string) {
  return ModelProfileSchema.parse({ ...TOKENHUB, id });
}

describe('model profiles', () => {
  it('names team secrets by repo identity alone, surviving teamai.yaml renames', async () => {
    const repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-team-'));
    try {
      await fse.writeFile(path.join(repo, 'teamai.yaml'), 'team: HAI Platform\n');
      const config = { repo: { localPath: repo, remote: 'origin', url: 'https://example.test/hai' } } as LocalConfig;
      const file = getTeamValuesPath(config);
      expect(path.basename(file)).toMatch(/^[a-f0-9]{10}\.json$/);
      expect(path.dirname(file)).toContain(path.join('models', 'teams'));
      // The team display name and a repo: claim must not move the file (#894).
      await fse.writeFile(path.join(repo, 'teamai.yaml'), 'team: Relocated\nrepo: https://example.test/elsewhere\n');
      expect(getTeamValuesPath(config)).toBe(file);
      // A different repository URL names a different file.
      const other = getTeamValuesPath({ repo: { localPath: `${repo}-other`, remote: 'origin', url: 'https://example.test/other' } } as LocalConfig);
      expect(path.basename(other)).not.toBe(path.basename(file));
      // scp and ssh URLs for the same repository name one file (#880 semantics).
      const scp = getTeamValuesPath({ repo: { localPath: repo, remote: 'origin', url: 'git@example.test:acme/team.git' } } as LocalConfig);
      const ssh = getTeamValuesPath({ repo: { localPath: repo, remote: 'origin', url: 'ssh://git@example.test:22/acme/team' } } as LocalConfig);
      expect(scp).toBe(ssh);
    } finally {
      await fse.remove(repo);
    }
  });

  it('matches the current hash name and only legacy digests this config could have produced', async () => {
    const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
    const config = { repo: { localPath: '/tmp/example/hai', remote: 'origin', url: 'https://example.test/hai.git' } } as LocalConfig;
    expect(sameTeamIdentity(getTeamIdentity(config), config)).toBe(true);
    // A legacy name keyed by the URL digest names the same team.
    expect(sameTeamIdentity(`hai-platform-${digest('https://example.test/hai.git')}`, config)).toBe(true);      // A legacy name keyed by a non-origin REMOTE URL digest names the same team.
    const fork = { repo: { localPath: '/tmp/example/hai', remote: 'fork', url: 'https://example.test/hai.git' } } as LocalConfig;
      expect(sameTeamIdentity(`hai-${digest('https://example.test/hai.git')}`, fork)).toBe(true);
      // But a bare alias never names a file: two checkouts sharing it stay distinct.
      const forkA = getTeamValuesPath({ repo: { localPath: '/tmp/example/a', remote: 'fork', url: 'https://example.test/a' } } as LocalConfig);
      const forkB = getTeamValuesPath({ repo: { localPath: '/tmp/example/b', remote: 'fork', url: 'https://example.test/b' } } as LocalConfig);
      expect(forkA).not.toBe(forkB);
    // A digest from another repository, or one this config never produced, must not match.
    expect(sameTeamIdentity(`hai-platform-${digest('https://example.test/other.git')}`, config)).toBe(false);
    expect(sameTeamIdentity('hai-platform-0000000000', config)).toBe(false);
    expect(sameTeamIdentity(undefined, config)).toBe(false);
    // The repo: claim in teamai.yaml overrode the identity in the old implementation,
    // so the stored digest is its: it must match (src/models/profile.ts).
    const claimRepo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-claim-'));
    await fse.writeFile(path.join(claimRepo, 'teamai.yaml'), 'team: HAI Platform\nrepo: https://git.example.test/acme/team.git\n');
    const withClaim = { repo: { localPath: claimRepo, remote: 'origin', url: 'https://example.test/hai.git' } } as LocalConfig;
    try {
      expect(sameTeamIdentity(`hai-platform-${digest('https://git.example.test/acme/team.git')}`, withClaim)).toBe(true);
    } finally {
      await fse.remove(claimRepo);
    }
    // The local path was hashed only when nothing better was configured. It
    // names no single repository (the path is reused), and — like every
    // provider-ambiguous digest — no record under it is attributed by slug
    // alone, because a same-named team on another provider shares the slug.
    const pathOnly = { repo: { localPath: '/tmp/example/hai', remote: 'origin' } } as LocalConfig;
    expect(sameTeamIdentity(`hai-${digest('/tmp/example/hai')}`, pathOnly)).toBe(false);
    expect(sameTeamIdentity(`hai-platform-${digest('/tmp/example/hai')}`, pathOnly)).toBe(false);
  });

  it('rejects every alias-digest switch record — the slug is not provenance', async () => {
    const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
    // Two teams shared the bare alias `fork`; each keyed records under its own
    // slug, but the old name never encoded the provider, so a same-named team
    // on another provider would share team B's exact form. No alias record is
    // attributed by slug alone — only the owner's explicit adoption and a
    // re-switch re-records it under the provider-qualified identity.
    const teamB = { repo: { localPath: '/tmp/example/team-b', remote: 'fork', url: 'https://example.test/b.git' } } as LocalConfig;
    expect(sameTeamIdentity(`team-a-${digest('fork')}`, teamB)).toBe(false);
    expect(sameTeamIdentity(`team-b-${digest('fork')}`, teamB)).toBe(false);
    // A repository-bound digest needs no slug check: the host is in the identity.
    expect(sameTeamIdentity(`renamed-team-${digest('https://example.test/b.git')}`, teamB)).toBe(true);
  });

  it('matches the repo: claim, not the path, when the config has no url', async () => {
    const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
    const claimRepo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-claim-nourl-'));
    await fse.writeFile(path.join(claimRepo, 'teamai.yaml'), 'team: HAI\nrepo: https://git.example.test/canonical.git\n');
    const config = { repo: { localPath: claimRepo, remote: 'origin' } } as LocalConfig;
    try {
      // The claim, not the path, is what the old implementation hashed here;
      // the claim digest (post-repoIdentity) is a matching legacy candidate...
      expect(sameTeamIdentity(`hai-${digest('https://git.example.test/canonical.git')}`, config)).toBe(true);
      // ...and a path-digest record from another team at this path is not.
      expect(sameTeamIdentity(`old-team-${digest(claimRepo)}`, config)).toBe(false);
      const target = getTeamValuesPath(config);
      const dir = path.dirname(target);
      await fse.ensureDir(dir);
      const oldTeam = path.join(dir, `old-team-${digest(claimRepo)}.json`);
      await fse.writeFile(oldTeam, '{"team:old":{"API_KEY":{"value":"old"}}}');
      expect(await findTeamValuesPath(config)).toBe(target);
      expect(await fse.pathExists(oldTeam)).toBe(true);
    } finally {
      await fse.remove(claimRepo);
    }
  });

  it('separates teams that reuse a path when a repo: claim is available', async () => {
    const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-reuse-'));
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      const repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-reuse-repo-'));
      const teamA = { repo: { localPath: repo, remote: 'origin' } } as LocalConfig;
      await fse.writeFile(path.join(repo, 'teamai.yaml'), 'team: Alpha\nrepo: https://git.example.test/alpha.git\n');
      const fileA = getTeamValuesPath(teamA);
      expect(path.basename(fileA)).toBe(`${digest('https://git.example.test/alpha')}.json`);
      // The same path, now checked out for team B with its own claim: no
      // shared file, no adopted switches.
      await fse.writeFile(path.join(repo, 'teamai.yaml'), 'team: Beta\nrepo: https://git.example.test/beta.git\n');
      const teamB = { repo: { localPath: repo, remote: 'origin' } } as LocalConfig;
      const fileB = getTeamValuesPath(teamB);
      expect(fileB).not.toBe(fileA);
      expect(path.basename(fileB)).toBe(`${digest('https://git.example.test/beta')}.json`);
      // Team A's file and switch record belong to team A alone.
      await fse.ensureDir(path.dirname(fileA));
      await saveModelInputs(fileA, { 'team:gw': { API_KEY: { value: 'alpha-key' } } });
      expect(await findTeamValuesPath(teamB)).toBe(fileB);
      expect(await fse.pathExists(fileB)).toBe(false);
      expect(sameTeamIdentity(path.basename(fileA, '.json'), teamB)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      await fse.remove(home);
    }
  });

  it('separates provider-relative identities by provider', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-provider-'));
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      const repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-provider-repo-'));
      // Same owner/repo claim, no URL anywhere: only the provider tells the teams apart.
      await fse.writeFile(path.join(repo, 'teamai.yaml'), 'team: GH\nrepo: acme/widgets\n');
      const onGithub = { repo: { localPath: repo, remote: 'origin' }, provider: 'github' } as LocalConfig;
      await fse.writeFile(path.join(repo, 'teamai.yaml'), 'team: GC\nrepo: acme/widgets\n');
      const onGitcode = { repo: { localPath: repo, remote: 'origin' }, provider: 'gitcode' } as LocalConfig;
      const githubFile = getTeamValuesPath(onGithub);
      const gitcodeFile = getTeamValuesPath(onGitcode);
      expect(githubFile).not.toBe(gitcodeFile);
      // A path-shaped identity is provider-qualified; a URL is not (it carries its host).
      expect(sameTeamIdentity(path.basename(githubFile, '.json'), onGithub)).toBe(true);
      expect(sameTeamIdentity(path.basename(githubFile, '.json'), onGitcode)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      await fse.remove(home);
    }
  });

  it('reads a path-shaped claim legacy file only after the user adopts the identity', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-effective-'));
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      const repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-effective-repo-'));
      const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
      // Team GH keyed its file on the bare, provider-ambiguous claim digest.
      await fse.writeFile(path.join(repo, 'teamai.yaml'), 'team: GH\nrepo: acme/widgets\nprovider: github\n');
      const dir = path.dirname(getTeamValuesPath({ repo: { localPath: repo, remote: 'origin' } } as LocalConfig));
      const legacy = path.join(dir, `gh-${digest('acme/widgets')}.json`);
      await fse.ensureDir(dir);
      await fse.writeFile(legacy, '{"team:gw":{"API_KEY":{"value":"legacy-key"}}}');
      const onGithub = { repo: { localPath: repo, remote: 'origin' } } as LocalConfig;
      // Same slug, same bare claim: the provider is missing from the identity,
      // so the file is NEVER auto-read — not even under this checkout's own slug.
      expect(await findTeamValuesPath(onGithub)).toBe(getTeamValuesPath(onGithub));
      expect(await unadoptedLegacyFiles(onGithub, { adopted: new Set() })).toContainEqual(
        expect.objectContaining({ entry: `gh-${digest('acme/widgets')}.json`, identity: `gh-${digest('acme/widgets')}` }),
      );
      // The user's explicit adoption of THIS exact identity reads it in place.
      expect(await findTeamValuesPath(onGithub, { adopted: new Set([`${getTeamValuesPath(onGithub)}::gh-${digest('acme/widgets')}`]) })).toBe(legacy);
      // Switch records are never provenance: a different slug is another team,
      // and the same slug could be a same-named team on another provider —
      // the bare claim made both digests identical. So neither matches.
      expect(sameTeamIdentity(`gc-${digest('acme/widgets')}`, onGithub)).toBe(false);
      expect(sameTeamIdentity(`gh-${digest('acme/widgets')}`, onGithub)).toBe(false);
      // A rename (same provider, new slug) keeps the same provider-qualified
      // target, and still needs the same explicit opt-in for the legacy file.
      await fse.writeFile(path.join(repo, 'teamai.yaml'), 'team: GC\nrepo: acme/widgets\nprovider: github\n');
      const renamed = { repo: { localPath: repo, remote: 'origin' } } as LocalConfig;
      expect(getTeamValuesPath(renamed)).toBe(getTeamValuesPath(onGithub));
      expect(await findTeamValuesPath(renamed)).toBe(getTeamValuesPath(renamed));
      expect(await findTeamValuesPath(renamed, { adopted: new Set([`${getTeamValuesPath(renamed)}::gh-${digest('acme/widgets')}`]) })).toBe(legacy);
      // Migration writes the provider-qualified target; from then on the legacy
      // file is shadowed and is never offered for adoption again — no re-prompts.
      await saveModelInputs(getTeamValuesPath(onGithub), { 'team:gw': { API_KEY: { value: 'legacy-key' } } });
      expect(await unadoptedLegacyFiles(onGithub, { adopted: new Set() })).toEqual([]);
      expect(await findTeamValuesPath(onGithub)).toBe(getTeamValuesPath(onGithub));
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      await fse.remove(home);
    }
  });

  it('never reads another team\'s path-shaped claim file, keys or switches', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-noleak-'));
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      const repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-noleak-repo-'));
      const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
      // GitHub team Alpha keyed its values on the bare claim digest.
      await fse.writeFile(path.join(repo, 'teamai.yaml'), 'team: Alpha\nrepo: acme/widgets\nprovider: github\n');
      const alphaFile = getTeamValuesPath({ repo: { localPath: repo, remote: 'origin' } } as LocalConfig);
      await fse.ensureDir(path.dirname(alphaFile));
      const alphaLegacy = path.join(path.dirname(alphaFile), `alpha-${digest('acme/widgets')}.json`);
      await fse.writeFile(alphaLegacy, '{"team:gw":{"API_KEY":{"value":"alpha-key"}}}');
      // GitCode team Beta has the same claim: the same old digest, a foreign file.
      await fse.writeFile(path.join(repo, 'teamai.yaml'), 'team: Beta\nrepo: acme/widgets\nprovider: gitcode\n');
      const onGitcode = { repo: { localPath: repo, remote: 'origin' }, provider: 'gitcode' } as LocalConfig;
      // The file surfaces in the disclosure but nothing is adopted silently.
      expect(await unadoptedLegacyFiles(onGitcode, { adopted: new Set() })).toEqual([
        expect.objectContaining({ entry: `alpha-${digest('acme/widgets')}.json` }),
      ]);
      expect(await findTeamValuesPath(onGitcode)).toBe(getTeamValuesPath(onGitcode));
      expect(sameTeamIdentity(`alpha-${digest('acme/widgets')}`, onGitcode)).toBe(false);
      // Beta adopting its OWN identity only still never selects Alpha's file.
      expect(await findTeamValuesPath(onGitcode, { adopted: new Set([`${getTeamValuesPath(onGitcode)}::beta-${digest('acme/widgets')}`]) })).toBe(getTeamValuesPath(onGitcode));
      // Nor do Beta's own legacy records attribute Beta: the same slug on
      // another provider shares the exact `beta-<digest>` form.
      expect(sameTeamIdentity(`beta-${digest('acme/widgets')}`, onGitcode)).toBe(false);
      // Finding 1 regression: a GitCode team ALSO named Alpha shares the slug —
      // the slug is not provenance, so Alpha's file is still never auto-read.
      await fse.writeFile(path.join(repo, 'teamai.yaml'), 'team: Alpha\nrepo: acme/widgets\nprovider: gitcode\n');
      const alphaOnGitcode = { repo: { localPath: repo, remote: 'origin' }, provider: 'gitcode' } as LocalConfig;
      expect(await findTeamValuesPath(alphaOnGitcode)).toBe(getTeamValuesPath(alphaOnGitcode));
      expect(await fse.readFile(alphaLegacy, 'utf8')).toContain('alpha-key');
      // Finding 2 regression: the same slug REALLY matches today — GitHub Alpha
      // and GitCode Alpha share `alpha-<digest>`, so an agent GitCode "owns"
      // must never be claimed from GitHub Alpha's record, even when GitCode
      // has its own provider-qualified key around. The record is refused,
      // same slug or not.
      expect(sameTeamIdentity(`alpha-${digest('acme/widgets')}`, alphaOnGitcode)).toBe(false);
      // Scope regression: adoption is keyed to the adopting scope's own
      // provider-qualified target. A separate GitHub checkout (its own
      // teamai.yaml) having adopted the same-basename file under ITS github
      // target authorizes nothing for this GitCode checkout — the targets
      // differ, so the key does not match.
      const repoGithub = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-noleak-gh-'));
      await fse.writeFile(path.join(repoGithub, 'teamai.yaml'), 'team: Alpha\nrepo: acme/widgets\nprovider: github\n');
      const onGithubScope = { repo: { localPath: repoGithub, remote: 'origin' } } as LocalConfig;
      expect(getTeamValuesPath(onGithubScope)).not.toBe(getTeamValuesPath(alphaOnGitcode));
      const adoptedUnderGithub = new Set([`${getTeamValuesPath(onGithubScope)}::alpha-${digest('acme/widgets')}`]);
      expect(await findTeamValuesPath(alphaOnGitcode, { adopted: adoptedUnderGithub })).toBe(getTeamValuesPath(alphaOnGitcode));
      // The GitCode scope adopting the same basename under ITS OWN target does
      // read it — that is the user's explicit consent — and next save migrates
      // it to the gitcode-qualified name.
      expect(await findTeamValuesPath(alphaOnGitcode, { adopted: new Set([`${getTeamValuesPath(alphaOnGitcode)}::alpha-${digest('acme/widgets')}`]) })).toBe(alphaLegacy);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      await fse.remove(home);
    }
  });

  it('adopts a renamed team\'s legacy file only by explicit opt-in, never machine state', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-rename-'));
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      const repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-rename-repo-'));
      const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
      // Team GH keyed its values on the bare claim digest; a beta-era file with
      // keys bound to no gateway.
      await fse.writeFile(path.join(repo, 'teamai.yaml'), 'team: GH\nrepo: acme/widgets\nprovider: github\n');
      const dir = path.dirname(getTeamValuesPath({ repo: { localPath: repo, remote: 'origin' } } as LocalConfig));
      const legacy = path.join(dir, `gh-${digest('acme/widgets')}.json`);
      await fse.ensureDir(dir);
      await fse.writeFile(legacy, '{"team:gw":{"API_KEY":{"value":"gh-key"}}}');
      // A rename under the same provider: nothing silently proves the file is
      // this checkout's former self — machine-global records would equally
      // belong to a same-digest foreign team (global store, self-validating).
      await fse.writeFile(path.join(repo, 'teamai.yaml'), 'team: GC\nrepo: acme/widgets\nprovider: github\n');
      const renamed = { repo: { localPath: repo, remote: 'origin' }, provider: 'github' } as LocalConfig;
      expect(await findTeamValuesPath(renamed)).toBe(getTeamValuesPath(renamed));
      expect(sameTeamIdentity(`gh-${digest('acme/widgets')}`, renamed)).toBe(false);
      // The user's explicit adoption of the former identity reads the file in
      // place; the next save migrates it to the provider-qualified name.
      expect(await findTeamValuesPath(renamed, { adopted: new Set([`${getTeamValuesPath(renamed)}::gh-${digest('acme/widgets')}`]) })).toBe(legacy);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      await fse.remove(home);
    }
  });

  it('a declined legacy file stays reachable and adoption merges every adopted identity\'s keys', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-partial-'));
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      const repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-partial-repo-'));
      const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
      await fse.writeFile(path.join(repo, 'teamai.yaml'), 'team: T\nrepo: acme/widgets\nprovider: github\n');
      const config = { repo: { localPath: repo, remote: 'origin' } } as LocalConfig;
      const dir = path.dirname(getTeamValuesPath(config));
      await fse.ensureDir(dir);
      // Two provider-ambiguous files share this checkout's digest — two teams'
      // former lives that both keyed on the bare claim, each with its own keys.
      const alpha = path.join(dir, `alpha-${digest('acme/widgets')}.json`);
      const beta = path.join(dir, `beta-${digest('acme/widgets')}.json`);
      await fse.writeFile(alpha, '{"team:gw":{"API_KEY":{"value":"alpha-key"}}}');
      await fse.writeFile(beta, '{"team:hw":{"API_KEY":{"value":"beta-key"}}}');
      // The migration guard sees BOTH before any target exists.
      expect(await unadoptedLegacyFiles(config, { adopted: new Set() })).toHaveLength(2);
      // Adopting only alpha must not hide beta: it still surfaces to the next
      // run, so the caller will not create the hash-only target (whose very
      // existence silences candidates) and beta's keys stay recoverable.
      const adoptedAlpha = new Set([`${getTeamValuesPath(config)}::alpha-${digest('acme/widgets')}`]);
      const afterPartial = await unadoptedLegacyFiles(config, { adopted: adoptedAlpha });
      expect(afterPartial.map((file) => file.entry)).toEqual([`beta-${digest('acme/widgets')}.json`]);
      // Adopting beta too: no candidate remains; the read picks one file, and
      // merging the other keeps every identity's keys instead of dropping them.
      const adoptedBoth = new Set([
        ...adoptedAlpha,
        `${getTeamValuesPath(config)}::beta-${digest('acme/widgets')}`,
      ]);
      expect(await unadoptedLegacyFiles(config, { adopted: adoptedBoth })).toEqual([]);
      const readFrom = await findTeamValuesPath(config, { adopted: adoptedBoth });
      const values = mergeModelInputs(await loadModelInputs(alpha), await loadModelInputs(readFrom));
      expect(values).toMatchObject({
        'team:gw': { API_KEY: { value: 'alpha-key' } },
        'team:hw': { API_KEY: { value: 'beta-key' } },
      });
      // A declining member records the file's identity durably instead of
      // letting it block migration: with beta declined, no candidate remains
      // (the guard proceeds) and the read skips beta — adopting alpha alone
      // no longer forces this team to absorb a foreign team's keys.
      const declinedBeta = new Set([`${getTeamValuesPath(config)}::beta-${digest('acme/widgets')}`]);
      expect(await unadoptedLegacyFiles(config, { adopted: adoptedAlpha, declined: declinedBeta })).toEqual([]);
      expect(await findTeamValuesPath(config, { adopted: adoptedAlpha, declined: declinedBeta })).toBe(alpha);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      await fse.remove(home);
    }
  });

  it('a foreign team\'s own state never admits another team\'s legacy file', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-unbound-'));
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      const repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-unbound-repo-'));
      const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
      await fse.writeFile(path.join(repo, 'teamai.yaml'), 'team: GH\nrepo: acme/widgets\nprovider: github\n');
      const dir = path.dirname(getTeamValuesPath({ repo: { localPath: repo, remote: 'origin' } } as LocalConfig));
      const legacy = path.join(dir, `gh-${digest('acme/widgets')}.json`);
      await fse.ensureDir(dir);
      await fse.writeFile(legacy, '{"team:gw":{"API_KEY":{"value":"gh-key"}}}');
      // A GitCode Beta team's presence and even its own claimed identity never
      // make GH's file readable without GH's identity being explicitly adopted.
      await fse.writeFile(path.join(repo, 'teamai.yaml'), 'team: GC\nrepo: acme/widgets\nprovider: gitcode\n');
      const onGitcode = { repo: { localPath: repo, remote: 'origin' }, provider: 'gitcode' } as LocalConfig;
      expect(await findTeamValuesPath(onGitcode, { adopted: new Set([`${getTeamValuesPath(onGitcode)}::beta-${digest('acme/widgets')}`]) })).toBe(getTeamValuesPath(onGitcode));
      expect(sameTeamIdentity(`gh-${digest('acme/widgets')}`, onGitcode)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      await fse.remove(home);
    }
  });

  it('provides distinct identities for the same provider-relative remote across providers', async () => {
    const dir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-remote-'));
    // A provider-relative remote names a repository only with its provider: the
    // same `owner/repo` remote on two providers must not share one values file.
    // Each team declares its own provider in teamai.yaml — the local override
    // is commonly absent.
    const githubPath = path.join(dir, 'github');
    const gitcodePath = path.join(dir, 'gitcode');
    await fse.mkdir(githubPath);
    await fse.mkdir(gitcodePath);
    await fse.writeFile(path.join(githubPath, 'teamai.yaml'), 'team: T\nprovider: github\n');
    await fse.writeFile(path.join(gitcodePath, 'teamai.yaml'), 'team: T\nprovider: gitcode\n');
    const onGithub = { repo: { localPath: githubPath, remote: 'owner/repo' } } as LocalConfig;
    const onGitcode = { repo: { localPath: gitcodePath, remote: 'owner/repo' } } as LocalConfig;
    expect(getTeamValuesPath(onGithub)).not.toBe(getTeamValuesPath(onGitcode));
    // Same provider-relative remote and provider name the same repository
    // regardless of path.
    expect(getTeamValuesPath(onGithub)).toBe(getTeamValuesPath({ repo: { localPath: '/elsewhere', remote: 'owner/repo' }, provider: 'github' } as LocalConfig));
  });

  it('a member\'s explicit provider overrides the team\'s declared provider', async () => {
    const repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-provider-override-'));
    // The team declares GitHub; a member initialized with `--provider gitlab`
    // must NOT receive the GitHub hash — the member's own initializer/override
    // wins, as everywhere else in the CLI. Otherwise that member would share
    // API keys and switch ownership with the actual GitHub checkout.
    await fse.writeFile(path.join(repo, 'teamai.yaml'), 'team: T\nrepo: acme/widgets\nprovider: github\n');
    const onGithub = { repo: { localPath: repo } } as LocalConfig;
    const memberGitlab = { repo: { localPath: repo }, provider: 'gitlab' } as LocalConfig;
    expect(getTeamValuesPath(memberGitlab)).not.toBe(getTeamValuesPath(onGithub));
    // The override is the identity: another checkout with no declared provider
    // but the same gitlab override shares the file with the member.
    expect(getTeamValuesPath(memberGitlab)).toBe(getTeamValuesPath({ repo: { localPath: '/elsewhere', remote: 'acme/widgets' }, provider: 'gitlab' } as LocalConfig));
  });

  it('keys different provider-relative remotes separately and never Windows drive paths as URLs', async () => {
    const repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-remote-prec-'));
    // The remote is the top identity: two checkouts with different
    // provider-relative remotes must never share one file — even when both
    // carry the same teamai.yaml claim and provider.
    await fse.writeFile(path.join(repo, 'teamai.yaml'), 'team: T\nrepo: acme/widgets\n');
    const remoteA = { repo: { localPath: repo, remote: 'acme/team-a' } } as LocalConfig;
    const remoteB = { repo: { localPath: repo, remote: 'acme/team-b' } } as LocalConfig;
    expect(getTeamValuesPath(remoteA)).not.toBe(getTeamValuesPath(remoteB));
    // Same provider-relative remote and provider name the same repository
    // regardless of checkout path.
    expect(getTeamValuesPath(remoteA)).toBe(getTeamValuesPath({ repo: { localPath: '/elsewhere', remote: 'acme/team-a' } } as LocalConfig));
    // A provider-relative remote outranks a DIFFERENT claim: the remote names
    // the repo, the claim merely repeats it (matching remote keys the claim's).
    await fse.writeFile(path.join(repo, 'teamai.yaml'), 'team: T\nrepo: acme/team-b\n');
    expect(getTeamValuesPath(remoteB)).toBe(getTeamValuesPath({ repo: { localPath: repo, remote: 'acme/team-b' } } as LocalConfig));
    // A bare alias names no repository: it falls through to the
    // provider/slug/path identity, so adding it cannot change the file and
    // two teams sharing the alias stay separated by the slug.
    await fse.writeFile(path.join(repo, 'teamai.yaml'), 'team: Alpha\n');
    const pathOnly = getTeamValuesPath({ repo: { localPath: repo } } as LocalConfig);
    expect(getTeamValuesPath({ repo: { localPath: repo, remote: 'sharing' } } as LocalConfig)).toBe(pathOnly);
    await fse.writeFile(path.join(repo, 'teamai.yaml'), 'team: Beta\n');
    expect(getTeamValuesPath({ repo: { localPath: repo, remote: 'sharing' } } as LocalConfig)).not.toBe(pathOnly);
    // Windows drive paths are paths, not URL schemes: a path-only config must
    // keep its provider-and-slug fallback instead of hashing a phantom URL.
    expect(isRepoReference('C:\\teams\\repo')).toBe(false);
    expect(isRepoReference('c:/teams/repo')).toBe(false);
    expect(isRepoReference('D:\\teams\\repo')).toBe(false);
    expect(isRepoReference('https://example.test/team.git')).toBe(true);
    expect(isRepoReference('git@example.test:acme/team.git')).toBe(true);
  });

  it('reads an alias-digest legacy file only under this team\'s slug', async () => {
    const previous = process.env.HOME;
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-alias-'));
    process.env.HOME = home;
    try {
      const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
      // Two teams keyed files on the same bare alias; only the slug told them apart.
      const config = { repo: { localPath: '/tmp/example/hai', remote: 'fork', url: 'https://example.test/hai.git' } } as LocalConfig;
      const target = getTeamValuesPath(config);
      const dir = path.dirname(target);
      await fse.ensureDir(dir);
      const foreign = path.join(dir, `other-team-${digest('fork')}.json`);
      await fse.writeFile(foreign, '{"team:other":{"API_KEY":{"value":"other-team-key"}}}');
      // Newest file, wrong slug: must not be adopted.
      await fse.utimes(foreign, new Date(2_000_000_000), new Date(2_000_000_000));
      expect(await findTeamValuesPath(config)).toBe(target);
      // No teamai.yaml here, so the old scheme fell back to the basename slug.
      const ours = path.join(dir, `hai-${digest('fork')}.json`);
      await fse.writeFile(ours, '{"team:gw":{"API_KEY":{"value":"our-key"}}}');
      await fse.utimes(ours, new Date(1_000_000_000), new Date(1_000_000_000));
      // Even our own slug needs the explicit opt-in: the alias never encoded
      // the provider, so the slug alone cannot prove ownership.
      expect(await findTeamValuesPath(config)).toBe(target);
      expect(await findTeamValuesPath(config, { adopted: new Set([`${getTeamValuesPath(config)}::hai-${digest('fork')}`]) })).toBe(ours);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      await fse.remove(home);
    }
  });

  it('reads the newest legacy file in place when several match', async () => {
    const previous = process.env.HOME;
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-legacy-'));
    process.env.HOME = home;
    try {
      const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
      const config = { repo: { localPath: '/tmp/example/hai', remote: 'origin', url: 'https://example.test/hai.git' } } as LocalConfig;
      const target = getTeamValuesPath(config);
      const dir = path.dirname(target);
      await fse.ensureDir(dir);
      const stale = path.join(dir, `hai-platform-${digest('https://example.test/hai.git')}.json`);
      await fse.writeFile(stale, '{"team:gw":{"API_KEY":{"value":"stale"}}}');
      const newer = path.join(dir, `relocated-${digest('https://example.test/hai.git')}.json`);
      await fse.writeFile(newer, '{"team:gw":{"API_KEY":{"value":"latest"}}}');
      // Deterministic mtimes: the stale file is the older one, whatever readdir order returns.
      await fse.utimes(stale, new Date(1_000_000_000), new Date(1_000_000_000));
      await fse.utimes(newer, new Date(2_000_000_000), new Date(2_000_000_000));
      // Newer wins even when readdir sorts the stale file first; nothing is renamed.
      expect(await findTeamValuesPath(config)).toBe(newer);
      expect(await fse.pathExists(stale)).toBe(true);
      expect(await fse.pathExists(newer)).toBe(true);
      expect(await fse.pathExists(target)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      await fse.remove(home);
    }
  });

  it('never reads a local-path digest when a URL was configured', async () => {
    const previous = process.env.HOME;
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-path-'));
    process.env.HOME = home;
    try {
      const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
      const config = { repo: { localPath: '/tmp/example/hai', remote: 'origin', url: 'https://example.test/hai.git' } } as LocalConfig;
      const target = getTeamValuesPath(config);
      const dir = path.dirname(target);
      await fse.ensureDir(dir);
      // What a previous team keyed on the default path left behind.
      const stale = path.join(dir, `old-team-${digest('/tmp/example/hai')}.json`);
      await fse.writeFile(stale, '{"team:old":{"API_KEY":{"value":"old-team-key"}}}');
      expect(await findTeamValuesPath(config)).toBe(target);
      expect(await fse.pathExists(target)).toBe(false);
      expect(await fse.pathExists(stale)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      await fse.remove(home);
    }
  });

  it('never reads a foreign team digest', async () => {
    const previous = process.env.HOME;
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-foreign-'));
    process.env.HOME = home;
    try {
      const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
      const config = { repo: { localPath: '/tmp/example/hai', remote: 'origin', url: 'https://example.test/hai.git' } } as LocalConfig;
      const target = getTeamValuesPath(config);
      const dir = path.dirname(target);
      await fse.ensureDir(dir);
      // Another team's values file shares the slug but not the digest.
      const foreign = path.join(dir, `hai-platform-${digest('https://example.test/foreign.git')}.json`);
      await fse.writeFile(foreign, 'foreign');
      expect(await findTeamValuesPath(config)).toBe(target);
      expect(await fse.pathExists(target)).toBe(false);
      expect(await fse.pathExists(foreign)).toBe(true);
      expect(sameTeamIdentity(`hai-platform-${digest('https://example.test/foreign.git')}`, config)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      await fse.remove(home);
    }
  });

  it('reads the legacy file in place and lets the next save shadow it', async () => {
    const previous = process.env.HOME;
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-shadow-'));
    process.env.HOME = home;
    try {
      const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
      const config = { repo: { localPath: '/tmp/example/hai', remote: 'origin', url: 'https://example.test/hai.git' } } as LocalConfig;
      const target = getTeamValuesPath(config);
      const dir = path.dirname(target);
      await fse.ensureDir(dir);
      const legacy = path.join(dir, `hai-platform-${digest('https://example.test/hai.git')}.json`);
      await fse.writeFile(legacy, '{"team:gw":{"API_KEY":{"value":"old"}}}');
      // Reads go to the legacy file; nothing is created or renamed.
      expect(await findTeamValuesPath(config)).toBe(legacy);
      expect(await fse.pathExists(target)).toBe(false);
      // Once saved, the hash-only file exists and shadows the legacy one.
      await saveModelInputs(target, { 'team:gw': { API_KEY: { value: 'fresh' } } });
      expect(await findTeamValuesPath(config)).toBe(target);
      expect(JSON.parse(await fse.readFile(target, 'utf8'))['team:gw']['API_KEY'].value).toBe('fresh');
      expect(await fse.pathExists(legacy)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      await fse.remove(home);
    }
  });

  it('returns the hash-only path when present, absent, or without a teams dir', async () => {
    const previous = process.env.HOME;
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-hash-'));
    process.env.HOME = home;
    try {
      const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
      const config = { repo: { localPath: '/tmp/example/hai', remote: 'origin', url: 'https://example.test/hai' } } as LocalConfig;
      const target = getTeamValuesPath(config);
      const dir = path.dirname(target);
      await fse.ensureDir(dir);
      const foreign = path.join(dir, `hai-platform-${digest('https://example.test/foreign.git')}.json`);
      await fse.writeFile(foreign, 'foreign');
      // Target exists: it wins over any legacy file.
      await fse.writeFile(target, 'current');
      expect(await findTeamValuesPath(config)).toBe(target);
      expect(await fse.readFile(target, 'utf8')).toBe('current');
      // No matching legacy file: the hash-only path, nothing created.
      await fse.remove(target);
      expect(await findTeamValuesPath(config)).toBe(target);
      expect(await fse.pathExists(target)).toBe(false);
      expect(await fse.pathExists(foreign)).toBe(true);
      // Missing teams directory entirely: same graceful return.
      await fse.remove(dir);
      expect(await findTeamValuesPath(config)).toBe(target);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      await fse.remove(home);
    }
  });

  it('resolves model groups into protocol routes without repeating model IDs', () => {
    const parsed = ModelProfileSchema.parse({
      ...TOKENHUB,
      model_groups: [
        { protocols: ['anthropic'], models: ['claude-opus-4-8'] },
        { protocols: ['anthropic', 'openai-chat-completions'], models: ['deepseek-v4-flash'] },
      ],
    });
    const resolved = resolveProfile(
      { source: 'team', profile: parsed },
      { 'team:tokenhub@https://tokenhub.tencentmaas.com': { API_KEY: { value: 'local-secret' } } },
    );
    expect(resolved.routes.anthropic).toEqual({
      base_url: 'https://tokenhub.tencentmaas.com',
      models: ['claude-opus-4-8', 'deepseek-v4-flash'],
    });
    expect(resolved.routes['openai-chat-completions']).toEqual({
      base_url: 'https://tokenhub.tencentmaas.com/v1',
      models: ['deepseek-v4-flash'],
    });
    expect(resolved.api_key_value).toBe('local-secret');
  });

  it('puts a chosen default model first in every route that serves it', () => {
    const values = { 'team:tokenhub@https://tokenhub.tencentmaas.com': { API_KEY: { value: 'local-secret' } } };
    const resolved = resolveProfile({ source: 'team', profile: profile('tokenhub') }, values, 'deepseek-v4-flash');
    expect(resolved.routes.anthropic?.models).toEqual(['deepseek-v4-flash', 'glm-5.3']);
    expect(resolved.routes['openai-chat-completions']?.models).toEqual(['deepseek-v4-flash', 'glm-5.3']);
    expect(() => resolveProfile({ source: 'team', profile: profile('tokenhub') }, values, 'missing-model'))
      .toThrow(/has no model missing-model/);
  });

  it('makes one three-protocol model available to each compatible agent', () => {
    const parsed = ModelProfileSchema.parse({
      ...TOKENHUB,
      model_groups: [{ protocols: ['anthropic', 'openai-chat-completions', 'openai-responses'], models: ['glm-5.3'] }],
    });
    expect(profileRoutes(parsed)).toEqual({
      anthropic: ['glm-5.3'],
      'openai-chat-completions': ['glm-5.3'],
      'openai-responses': ['glm-5.3'],
    });
    expect(profileAgents(parsed)).toEqual(['claude', 'codex', 'opencode', 'codebuddy', 'workbuddy', 'pi', 'omp']);
    expect(profileAgents(profile('tokenhub'))).toEqual(['claude', 'opencode', 'codebuddy', 'workbuddy', 'pi', 'omp']);
  });

  it('keeps api_key as a placeholder and rejects secrets or placeholders elsewhere', () => {
    expect(profileRoutes(ModelProfilesFileSchema.parse({ profiles: [TOKENHUB] }).profiles[0]).anthropic).toEqual(['glm-5.3', 'deepseek-v4-flash']);
    const invalid = (changes: Record<string, unknown>) => ModelProfilesFileSchema.parse({ profiles: [{ ...TOKENHUB, ...changes }] });
    expect(() => invalid({ api_key: 'sk-plaintext' })).toThrow(/configure the secret locally/);
    expect(() => invalid({ api_key: undefined })).toThrow(/api_key/);
    expect(() => invalid({ base_url: '${GATEWAY_URL}' })).toThrow(/http or https URL/);
    expect(() => invalid({ base_url: 'https://example.test/v1' })).toThrow(/without \/v1/);
    expect(() => invalid({ base_url: 'https://user:secret@example.test' })).toThrow(/without embedded credentials, query, or fragment/);
    expect(() => invalid({ base_url: 'https://example.test?api_key=sk-secret' })).toThrow(/without embedded credentials, query, or fragment/);
    expect(() => invalid({ base_url: 'https://example.test#sk-secret' })).toThrow(/without embedded credentials, query, or fragment/);
  });

  it('rejects unknown fields and repeated model IDs in a team catalog', () => {
    expect(() => ModelProfilesFileSchema.parse({ profiles: [TOKENHUB], credentials: 'plain-secret' })).toThrow(/Unrecognized key.*credentials/);
    expect(() => ModelProfilesFileSchema.parse({ profiles: [{ ...TOKENHUB, apiKey: 'plain-secret' }] })).toThrow(/Unrecognized key.*apiKey/);
    expect(() => ModelProfilesFileSchema.parse({ profiles: [{ ...TOKENHUB, agents: {} }] })).toThrow(/Unrecognized key.*agents/);
    expect(() => ModelProfilesFileSchema.parse({ profiles: [{ ...TOKENHUB, model_groups: [{ ...TOKENHUB.model_groups[0], credentials: 'plain-secret' }] }] })).toThrow(/Unrecognized key.*credentials/);
    expect(() => ModelProfilesFileSchema.parse({ profiles: [{ ...TOKENHUB, model_groups: [
      { protocols: ['anthropic'], models: ['one'] },
      { protocols: ['openai-responses'], models: ['one'] },
    ] }] })).toThrow(/duplicate model id one/);
  });

  it('saves a local profile in the team catalog format without a version header', async () => {
    const previous = process.env.HOME;
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-save-'));
    process.env.HOME = home;
    try {
      await saveLocalProfiles(ModelProfilesFileSchema.parse({ profiles: [TOKENHUB] }));
      const raw = await fse.readFile(path.join(home, '.teamai', 'models', 'models.yaml'), 'utf8');
      expect(raw).not.toContain('version:');
      expect(raw).toContain('api_key: ${API_KEY}');
      expect(raw).toContain('base_url: https://tokenhub.tencentmaas.com');
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      await fse.remove(home);
    }
  });

  it('fails closed without overwriting malformed local input JSON', async () => {
    const dir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-inputs-'));
    const file = path.join(dir, 'values.json');
    const malformed = '{"local:corp":';
    try {
      await fse.writeFile(file, malformed);
      await expect(loadModelInputs(file)).rejects.toThrow(/Cannot parse local model inputs/);
      expect(await fse.readFile(file, 'utf8')).toBe(malformed);
    } finally {
      await fse.remove(dir);
    }
  });

  it('requires a namespace when team and local IDs collide', () => {
    const team: ModelProfilesFile = { version: 1, profiles: [profile('same')] };
    const local: ModelProfilesFile = { version: 1, profiles: [profile('same')] };
    expect(() => resolveProfileRef('same', team, local)).toThrow(/Ambiguous.*team:same.*local:same/);
    expect(resolveProfileRef('local:same', team, local).source).toBe('local');
  });

  it('uses a team key only for the gateway origin it was stored for', () => {
    const values = { 'team:corp@https://tokenhub.tencentmaas.com': { API_KEY: { value: 'company-secret' } } };
    const samehost = ModelProfileSchema.parse({ ...TOKENHUB, id: 'corp', base_url: 'https://tokenhub.tencentmaas.com/project' });
    expect(resolveProfile({ source: 'team', profile: samehost }, values).api_key_value).toBe('company-secret');
    const otherhost = ModelProfileSchema.parse({ ...TOKENHUB, id: 'corp', base_url: 'https://gateway.project.test' });
    expect(() => resolveProfile({ source: 'team', profile: otherhost }, values))
      .toThrow(/team:corp has no API key for https:\/\/gateway\.project\.test/);
    // A key stored by id alone is never used without the root profile it was configured for.
    expect(() => resolveProfile({ source: 'team', profile: profile('corp') }, { 'team:corp': { API_KEY: { value: 'old' } } }))
      .toThrow(/has no API key/);
  });

  it('resolves environment-backed keys without persisting their values', () => {
    const values = { 'team:corp@https://tokenhub.tencentmaas.com': { API_KEY: { env: 'TEAMAI_TEST_MODEL_KEY' } } };
    process.env.TEAMAI_TEST_MODEL_KEY = 'from-env';
    try {
      const resolved = resolveProfile({ source: 'team', profile: profile('corp') }, values);
      expect(resolved.api_key_value).toBe('from-env');
      expect(resolved.api_key_env).toBe('TEAMAI_TEST_MODEL_KEY');
    } finally {
      delete process.env.TEAMAI_TEST_MODEL_KEY;
    }
    expect(() => resolveProfile({ source: 'team', profile: profile('corp') }, values))
      .toThrow(/TEAMAI_TEST_MODEL_KEY is not set/);
  });
});
