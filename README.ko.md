<p align="center">
  <img src="assets/teamai-cli-logo.svg" alt="teamai-cli">
</p>

<h1 align="center">TeamAI — Make Every Team AI Native</h1>

<p align="center">
  <a href="https://trendshift.io/repositories/123184?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-123184" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/123184" alt="Tencent%2Fteamai-cli | Trendshift" width="250" height="55"/></a>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.th.md">ไทย</a>
</p>

<p align="center">
  <a href="https://github.com/Tencent/teamai-cli/actions/workflows/ci.yml"><img src="https://github.com/Tencent/teamai-cli/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/teamai-cli"><img src="https://img.shields.io/npm/v/teamai-cli.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/teamai-cli"><img src="https://img.shields.io/npm/dm/teamai-cli.svg" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

**팀이 AI와 함께 일하고, 배우고, 개선해 나가기 위한 공통 기반.**

TeamAI는 개인의 AI 역량을 팀 공동의 역량으로 바꾸고, 여러 Agent와 기기, 팀원 전반에서 활용할 수 있게 합니다.

## 왜 TeamAI인가

<p align="center">
  <img src="assets/use-cases.png" alt="일상적인 8가지 상황: TeamAI 도입 전과 후" width="100%">
</p>

## 빠른 시작

아래 한 문장을 AI 도구에 보내세요:

```text
teamai skill을 설치해줘: https://github.com/Tencent/teamai-cli/tree/main/skills/teamai , teamai skill을 로드한 다음 우리 팀의 TeamAI를 처음부터 구축해줘.
```

TeamAI를 설정한 뒤에는 AI 도구에서 `/teamai` skill에게 말만 걸면 됩니다:

**팀을 처음부터 구축**

```text
/teamai 우리 팀의 TeamAI를 처음부터 구축해줘
```

**팀 참여**

```text
/teamai 우리 팀의 TeamAI에 참여하고 싶어, 저장소 URL은 https://github.com/your-org/your-repo
```

**팀에 공유하기**

Skills, Rules, MCP 등 Agent가 사용할 수 있는 리소스는 모두 공유할 수 있습니다:

```text
/teamai xxx skill을 팀에 공유해줘
```

**대시보드 열기**

```text
/teamai TeamAI 대시보드 열어줘
```

팀원이 한 번 접속하면, 에이전트를 여는 것만으로 팀의 모든 AI 자산을 쓸 수 있습니다.

<details>
<summary>명령줄 설치</summary>

### 설치

```bash
npm install -g teamai-cli
```

### 팀 관리자 / 개인 사용자

Git 호스트(GitHub, GitLab, GitCode, CNB, TGit 또는 비공개 Git 서비스)에 공유 경험 저장소를 만들고, **팀원에게 쓰기 권한을 부여한 뒤** `teamai init https://github.com/your-org/your-repo`를 실행하세요.

> **아직 팀 저장소가 없나요?** 프로덕션에 바로 쓸 수 있는 Skills, Rules, review agents가 미리 들어 있는 템플릿으로 시작하세요. [teamai-hub](https://github.com/teamai-hub) org를 둘러본 뒤 **Fork**하고, 새로 만든 저장소에 `teamai init`을 실행하면 됩니다.

### 팀원

```bash
# Choose one, depending on where you want resources installed

# Project-scope init (default, resources installed under the project directory)
cd /path/to/my-project
teamai init https://github.com/your-org/your-repo

# Or, user-scope init (resources installed under ~/)
teamai init https://github.com/your-org/your-repo --scope user
```

초기화가 끝나면 관리자가 배포한 최신 Skills / Rules 및 기타 Harness 업데이트가 매 AI 세션에서 자동으로 반영됩니다. 수동 동기화는 필요 없습니다.

</details>

## 제품 개요

Git을 기반으로 세 층의 역량을 구축합니다:

- **Team Execution** — 모든 에이전트가 팀의 방식대로 일하게 합니다: skills, rules, docs, env, agents, hooks, MCP, models.
- **Team Context** (beta) — 모든 에이전트가 팀을 이해하게 합니다: learnings, 코드베이스 그래프, teamwiki.
- **Team Improvement** (beta) — 매 실행이 팀의 역량으로 쌓이게 합니다: usage, sessions, dashboard.

<table>
  <thead>
    <tr>
      <th rowspan="2">Agent</th>
      <th colspan="8">Team Execution</th>
      <th colspan="3">Team Context (beta)</th>
      <th colspan="3">Team Improvement (beta)</th>
    </tr>
    <tr>
      <th>skills</th><th>rules</th><th>docs</th><th>env</th><th>agents</th><th>hooks</th><th>mcp</th><th>models</th>
      <th>learnings</th><th>codebase</th><th>teamwiki</th>
      <th>usage</th><th>sessions</th><th>dashboard</th>
    </tr>
  </thead>
  <tbody>
    <tr><td>Claude Code</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>Codex</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>Cursor</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>GitHub Copilot CLI</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>CodeBuddy</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>WorkBuddy</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>OpenCode</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>Pi Coding Agent</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>OpenClaw</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>Hermes</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>DeepSeek Harness</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>Qoder</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>Qoder CN</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>Kiro</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>ZCode</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>Oh My Pi</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
  </tbody>
</table>

## 자세히 알아보기

- [Usage Guide](docs/usage-guide.md) — setup, onboarding, daily workflows, and commands
- [Product Overview](docs/product-overview.md) — architecture, distribution controls, and capability details
- [Git Providers](docs/providers.md) — supported repository providers
- [Windows Setup](docs/windows-hooks.md) — hooks and shell configuration
- [Technical Designs](docs/designs/) — design documents and proposals

## 기여자

TeamAI에 기여해 주신 모든 분께 감사합니다!

<a href="https://github.com/Tencent/teamai-cli/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Tencent/teamai-cli" alt="Contributors" />
</a>

[contrib.rocks](https://contrib.rocks)로 생성했습니다.

## 기여하기

커뮤니티 참여, Issue, PR을 환영합니다. 기여 방법은 [CONTRIBUTING.md](.github/CONTRIBUTING.md)를 참고하세요.

## 라이선스

[MIT](LICENSE)
