import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import YAML from 'yaml';

/**
 * Shared hermetic fixture for the Config WebUI test suite:
 * a bare origin + clone (real git, offline), a team repo carrying every
 * resource type, and a temp HOME whose ~/.teamai/config.yaml points at it.
 */
export interface ConfigUiFixture {
  root: string;
  home: string;
  repoPath: string;
  originPath: string;
  /** ENV value planted in env.yaml — tests assert it NEVER appears in API bodies. */
  envSecretValue: string;
  cleanup(): void;
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

function skillMd(name: string, description: string, extra = ''): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${extra}\n`;
}

export function buildConfigUiFixture(): ConfigUiFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-configui-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });

  const envSecretValue = 'SUPER-SECRET-VALUE-42';

  // ── 1. seed worktree with every resource type ──────────
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  const w = (rel: string, content: string): void => {
    const target = path.join(seed, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };

  w('teamai.yaml', YAML.stringify({
    team: 'fixture-team',
    description: 'Config WebUI fixture team',
    repo: 'https://git.example.com/fixture/team.git',
    provider: 'git',
    sharing: {
      rules: { enforced: [] },
      env: { injectShellProfile: true },
      hooks: { autoApply: true, requireTeamScripts: false },
      recall: { enabled: false },
    },
  }));

  w(path.join('manifest', 'roles.yaml'), YAML.stringify({
    version: 7,
    roles: [
      { id: 'dev', description: '开发者', resources: { knowledge: ['common'], skills: ['core', 'shared'] } },
      { id: 'ops', description: '运维', resources: { knowledge: ['runbooks'], skills: ['ops'] } },
    ],
  }));

  w(path.join('skills', 'core', 'code-review', 'SKILL.md'), skillMd('code-review', '评审代码的最佳实践'));
  w(path.join('skills', 'core', 'unit-test', 'SKILL.md'), skillMd('unit-test', '单元测试编写指南'));
  w(path.join('skills', 'ops', 'deploy', 'SKILL.md'), skillMd('deploy', '部署操作手册'));
  w(path.join('skills', 'shared', 'docs-writing', 'SKILL.md'), skillMd('docs-writing', '文档写作技巧'));

  w(path.join('rules', 'coding-style.md'), `---\ndescription: 团队编码规范\n---\n\n# 编码规范\n\n- 使用 TypeScript strict 模式\n`);
  w(path.join('rules', 'review.md'), `---\ndescription: 评审流程\n---\n\n# 评审流程\n\n- 所有 PR 至少一人评审\n`);

  w(path.join('docs', 'onboarding.md'), `---\ntitle: 新人入职指南\n---\n\n# 入职指南\n\n第一天请完成环境配置。`);
  w(path.join('docs', 'arch', 'overview.md'), `---\ntitle: 架构总览\n---\n\n# 架构\n\n分层架构说明。`);

  w(path.join('env', 'env.yaml'), YAML.stringify({
    variables: [
      { key: 'TEAM_API_ENDPOINT', value: envSecretValue, description: 'api endpoint' },
      { key: 'TEAM_LOG_LEVEL', value: 'info' },
    ],
  }));

  w(path.join('agents', 'teamai-helper.yaml'), YAML.stringify({
    name: 'teamai-helper',
    description: '团队助手智能体',
    tools: ['Read', 'Bash'],
  }));

  w(path.join('hooks', 'hooks.yaml'), YAML.stringify({
    hooks: [
      { id: 'block-force-push', event: 'PreToolUse', matcher: 'Bash', command: '~/.teamai/team-scripts/block-force-push.sh', description: '阻止 force push' },
    ],
  }));

  w(path.join('mcp', 'mcp.yaml'), YAML.stringify({
    servers: [
      { name: 'fixture-mcp', description: '测试 MCP 服务器', transport: 'stdio', command: 'npx', args: ['-y', 'fixture-mcp'] },
    ],
  }));

  w('culture.md', `# 团队文化\n\n- 客户第一\n- 拥抱变化\n`);

  w(path.join('learnings', 'deploy-timeout-fix.md'), `---\ntitle: "部署超时排查"\nauthor: tester\ndate: 2026-08-01\ntags: [deploy, timeout]\n---\n\n部署超时时先检查健康探针。\n`);
  w(path.join('learnings', 'api-rate-limit.md'), `---\ntitle: "API 限流处理"\nauthor: tester\ndate: 2026-08-02\ntags: [api, rate-limit]\n---\n\n遇到 429 时使用指数退避重试。\n`);

  w('tags.yaml', YAML.stringify({
    skills: { deploy: ['infra'] },
    rules: { 'coding-style': ['quality'] },
  }));

  // ── 2. bare origin + push seed ──────────────────────────
  const originPath = path.join(root, 'origin.git');
  git(`init --bare -b master ${originPath}`, root);
  git('init -b master', seed);
  git('add -A', seed);
  git('commit -m "fixture seed"', seed);
  git(`remote add origin ${originPath}`, seed);
  git('push -u origin master', seed);
  // A product-line branch for the Branches tab.
  git('checkout -b release/v2', seed);
  w(path.join('skills', 'core', 'v2-only-skill', 'SKILL.md'), skillMd('v2-only-skill', '仅 v2 分支存在'));
  git('add -A', seed);
  git('commit -m "v2 skill"', seed);
  git('push origin release/v2', seed);
  git('checkout master', seed);

  // ── 3. clone = the configured localPath ────────────────
  const repoPath = path.join(root, 'team-repo');
  git(`clone ${originPath} ${repoPath}`, root);
  // default branch symref (origin/HEAD) set by clone

  // ── 4. HOME config (user scope) ────────────────────────
  const configDir = path.join(home, '.teamai');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.yaml'), YAML.stringify({
    repo: { localPath: repoPath, remote: 'https://git.example.com/fixture/team.git', kind: 'git' },
    username: 'tester',
    scope: 'user',
    primaryRole: 'dev',
    additionalRoles: [],
    resourceProfileVersion: 7,
  }));

  const prevHome = process.env.HOME;
  process.env.HOME = home;

  return {
    root,
    home,
    repoPath,
    originPath,
    envSecretValue,
    cleanup() {
      if (prevHome !== undefined) process.env.HOME = prevHome;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
