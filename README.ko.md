<p align="center">
  <img src="assets/teamai-cli-logo.svg" alt="teamai-cli">
</p>

# TeamAI — Make Every Team AI Native

> [English](README.md) | [中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [ไทย](README.th.md)

[![CI](https://github.com/Tencent/teamai-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Tencent/teamai-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/teamai-cli.svg)](https://www.npmjs.com/package/teamai-cli)
[![npm downloads](https://img.shields.io/npm/dm/teamai-cli.svg)](https://www.npmjs.com/package/teamai-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

TeamAI는 팀의 Skills, Rules, MCP, 지식을 Claude Code, Codex, CodeBuddy, WorkBuddy, OpenCode, Cursor 등 AI Agents 전반에서 관리합니다.

## 기여자

TeamAI에 기여해 주신 모든 분께 감사합니다!

<a href="https://trendshift.io/repositories/123184?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-123184" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/123184" alt="Tencent%2Fteamai-cli | Trendshift" width="250" height="55"/></a>

<a href="https://github.com/Tencent/teamai-cli/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Tencent/teamai-cli" alt="Contributors" />
</a>

[contrib.rocks](https://contrib.rocks)로 생성했습니다.

## 빠른 시작

### 설치

```bash
npm install -g teamai-cli
```

### 팀 관리자 / 개인 사용자

Git 호스트(GitHub, GitLab, GitCode, CNB, TGit 또는 비공개 Git 서비스)에 공유 경험 저장소를 만들고, **팀원에게 쓰기 권한을 부여한 뒤** `teamai init https://github.com/yourorg/yourrepo`를 실행하세요.

> **아직 팀 저장소가 없나요?** 프로덕션에 바로 쓸 수 있는 Skills, Rules, review agents가 미리 들어 있는 템플릿으로 시작하세요. [teamai-hub](https://github.com/teamai-hub) org를 둘러본 뒤 **Fork**하고, 새로 만든 저장소에 `teamai init`을 실행하면 됩니다.

### 팀원

```bash
# Choose one, depending on where you want resources installed

# Project-scope init (default, resources installed under the project directory)
cd /path/to/my-project
teamai init https://github.com/yourorg/yourrepo

# Or, user-scope init (resources installed under ~/)
teamai init https://github.com/yourorg/yourrepo --scope user
```

초기화가 끝나면 관리자가 배포한 최신 Skills / Rules 및 기타 Harness 업데이트가 매 AI 세션에서 자동으로 반영됩니다. 수동 동기화는 필요 없습니다.

> **전체 사용 가이드:** [docs/usage-guide.md](docs/usage-guide.md) ([中文版](docs/usage-guide.zh-CN.md)) — 팀 생성부터 일상 사용까지 모두 다룹니다.

## 제품 아키텍처

**Team Execution × Team Context (beta) × Team Improvement (beta)**:

| 계층 | 역할 | 현재 CLI에서 |
|-------|-----|-------------------|
| **Team Execution** | 모든 Agent가 팀의 방식대로 일하게 합니다 | `init` / `pull` / `push`, skills, rules, agents, hooks, MCP, env |
| **Team Context** (beta) | 모든 Agent가 팀을 이해하게 합니다 | recall, learnings, codebase graph, teamwiki... |
| **Team Improvement** (beta) | 모든 실행이 팀을 더 강하게 만듭니다 | 마찰 기반 share-learnings, sessions, digest, dashboard... |

## 개요

<table>
  <thead>
    <tr>
      <th rowspan="2">Agent</th>
      <th colspan="7">Team Execution</th>
      <th colspan="3">Team Context (beta)</th>
      <th colspan="3">Team Improvement (beta)</th>
    </tr>
    <tr>
      <th>skills</th><th>rules</th><th>docs</th><th>env</th><th>agents</th><th>hooks</th><th>mcp</th>
      <th>learnings</th><th>codebase</th><th>teamwiki</th>
      <th>usage</th><th>sessions</th><th>dashboard</th>
    </tr>
  </thead>
  <tbody>
    <tr><td>Claude Code</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>Codex</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>Cursor</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>CodeBuddy</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>WorkBuddy</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>OpenCode</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>OpenClaw</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>Hermes</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>DeepSeek Harness</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>Qoder</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>Kiro</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>ZCode</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
  </tbody>
</table>

**Git providers** — GitHub · GitLab · GitCode · CNB · TGit · 비공개 Git 서비스.

### 배포 제어

관리자가 한 번 설정하면 `teamai pull` 때 모든 멤버에게 전달되는 팀 전역 설정입니다.

| 기능 | 명령 | 하는 일 |
|------------|---------|--------------|
| **Projects** | `teamai projects` | 작업 디렉터리를 하나 이상의 논리 프로젝트에 묶어, 해당 프로젝트의 Skills, 지식, 격리된 learnings를 동기화합니다. Roles와는 별개의 차원입니다. |
| **Roles** | `teamai roles` | role → namespace 매핑을 정의해, 각 멤버가 자신의 role에 해당하는 Skills만 동기화하게 합니다. |
| **Tags** | `teamai tags` | Skills / Rules에 태그를 달아, 멤버가 필요한 태그만 구독하게 합니다. |
| **Sources** | `teamai source` | 추가 skill 저장소를 구독합니다 — 다른 팀의 공개 저장소, 또는 우리 org 안의 공유/공개 저장소. 구독한 Skills는 pull 때 자동 동기화됩니다. |

Learnings 격리: 저장소 루트의 `learnings/`는 전원과 공유되고, `learnings/<project-id>/`는 프로젝트 전용입니다. [usage guide](docs/usage-guide.md#multi-project-project-as-a-dimension-orthogonal-to-role)를 참고하세요.

## Team Execution

> One Team. One Harness. Every Agent.

TeamAI는 Skills, Rules, docs, hooks를 공유 Git 저장소에 두고, "push → review & merge → pull" 흐름으로 각 멤버의 로컬 AI 도구에 배포합니다. 다른 팀이나 공유 저장소의 Harness 구독도 지원합니다.

### 작동 방식

```
teamai push → create branch + MR → reviewer approves + merges
                                         ↓
              SessionStart hook → teamai pull → synced to local AI tools
```

### 공유되는 항목

각 리소스는 모든 Agent에 전달됩니다.

| 리소스 | 팀 저장소 위치 | 참고 |
|----------|------------------|-------|
| **Skills** | `skills/<name>/SKILL.md` | |
| **Rules** | `rules/*.md` | |
| **Docs** | `docs/` | 프로젝트 기반 문서. 기본값으로 전부 로드되지는 않습니다(progressive disclosure) |
| **Agents** | `agents/<name>.yaml` | |
| **Culture** | `culture.md` | 팀의 미션, 가치, 일하는 원칙 — 각 Agent의 CLAUDE.md / AGENTS.md에 주입되어 모든 세션이 이를 이어받습니다 |
| **CLAUDE.md** | `claudemd/*.md` | |
| **Env** | `env/` | 팀 단위 공유 환경 변수와 스위치. 시크릿은 넣지 마세요 |
| **Hooks** | `hooks/hooks.yaml` | 각 hook에 `roles:`를 달면 해당 role을 가진 멤버에게만 전달됩니다 |
| **MCP** | `mcp/mcp.yaml` | 각 server에 `roles:`를 달면 해당 role을 가진 멤버에게만 전달됩니다 |
| **Packages** | `teamai.yaml` | 현재는 npm 패키지와 Claude Code 플러그인만 지원 |
| **Models** | — | 아직 모든 provider에 구현되지 않았습니다 |

파일 형식과 전체 워크플로는 [Usage Guide](docs/usage-guide.md)를 참고하세요.

## Team Context (beta)

> Every agent understands how the team works.

Harness를 배포하는 것을 넘어, TeamAI는 쌓인 팀 경험과 코드 구조를 검색 가능한 지식 베이스로 정리하고, AI가 필요할 때 자동으로 불러오게 합니다.

### 경험 자동 공유

세션이 끝나면 Stop hook이 **friction**(마찰)으로 점수를 매깁니다. 세션에서 기억할 만한 일이 있었음을 나타내는 신호입니다. 예를 들어 AI를 중단하거나 고쳤거나, 도구 호출을 거절했거나, AI가 실패한 도구를 여러 번 재시도한 경우입니다. 도구 호출은 많지만 마찰이 없는 길고 평범한 세션은 트리거되지 않고, 실제로 문제를 붙잡고 씨름한 세션만 해당합니다. 점수가 충분하면 AI가 이렇게 제안합니다.

```
[teamai] This session may contain a problem worth documenting: you interrupted the AI twice, the AI retried failing tools 8 times.

Task: Fix duplicate project-level Hook injection

Consider running /teamai-share-learnings to summarize what you learned and share it with your team.
```

힌트에는 트리거가 된 0이 아닌 friction 신호가 나오고, 가능하면 첫 번째 작업을 마스킹한 한 줄 요약도 붙습니다. `/teamai-share-learnings` skill은 세션을 요약해 learning 문서를 팀 저장소에 바로 push합니다. 세션당 힌트는 최대 한 번입니다. 팀은 `teamai.yaml`에서 `sharing.contributeHint.enabled: false`로 힌트만 끌 수 있고(멤버는 로컬 설정의 `contributeHintEnabled`), Stop hook의 나머지 기능은 그대로 둡니다.

### 팀 지식 Recall

작업 전에 AI가 쌓인 팀 지식을 자동으로 검색하게 합니다. 이 기능은 **기본값이 꺼짐**이며, 명시적으로 켜야 합니다. 팀은 `teamai.yaml`에서 `sharing.recall.enabled: true`를 기본값으로 둘 수 있고, 멤버는 로컬에서 덮어쓸 수 있습니다.

```bash
teamai recall enable     # on: deploy the teamai-recall subagent + inject guidance rules
teamai recall disable    # off: remove the subagent and rules
teamai recall status     # show effective state (team default + user override)
```

**검색은 subagent로 실행됩니다**: 켜면 `teamai pull`이 내장 `teamai-recall` subagent를 각 AI 도구의 `agents/` 디렉터리에 배포합니다. AI는 작업 전에 이를 호출하고, subagent가 키워드를 뽑고, 검색을 돌리고, 맞은 원본 파일을 읽은 뒤 팀 지식의 구조화된 요약을 돌려줍니다. subagent는 먼저 관련성 사전 검사(`teamai recall --check`)를 하고, 작업이 팀 지식과 무관하면 검색을 아예 건너뜁니다. 내부적으로는 `teamai recall` 명령을 호출하며, 직접 실행할 수도 있습니다.

```bash
$ teamai recall "port conflict"
[1/2] MR review caught a port-conflict bug ★1 [user]
Author: member-a | Score: 18.5 | Tags: troubleshooting, networking

[2/2] Deployment configuration best practices [project]
Author: member-b | Score: 12.0 | Tags: deploy, config
Matched: conflict | Missing: port
```

### 코드베이스 지식 그래프

`teamai import`는 소스 저장소를 `teamwiki/` 아래의 구조화된 그래프로 파싱해, 구조를 아는 검색을 가능하게 합니다.

```bash
teamai import --from-repo https://github.com/org/repo
teamai import --from-org myorg              # batch import all repos
teamai codebase --extract /path/to/repo     # local extract into teamwiki/
teamai codebase --deep-enrich --project my-service --output /path/to/repo # generate deep knowledge docs
teamai codebase --reconcile --output /path/to/repo # map product docs to code pages
teamai codebase --lint --output /path/to/repo # check the locally extracted graph
```

Extract는 AI enrichment를 건너뛰거나 결과가 없어도 `teamwiki/evidence/code/<project>/_manifest.json`을 쓰므로 `--deep-enrich`를 이어서 시작할 수 있습니다.

그래프는 컴포넌트, 인터페이스, 설정, 저장소 간 import 엣지를 저장합니다. `teamai recall`은 이를 그래프 부스팅 재랭킹에 사용합니다.
recall 결과가 codebase 페이지에서 온 경우, 결과에는 관련 소스 파일 경로를 나열하는 `Sources:` 줄이 포함됩니다. Agent가 저장소를 다시 탐색하지 않고 코드 변경의 출발점을 바로 잡을 수 있습니다.

엣지는 함께 도는 두 트랙에서 나오며, 겹치면 AST 결과가 우선합니다.

- **AST track** (TypeScript/JavaScript, Python, Go): WASM [tree-sitter](https://tree-sitter.github.io/) 파서가 `import`/`require`, 호출 지점, TS `implements` 절을 파일 간 정확한 `DEPENDS_ON` / `REFERENCES` / `IMPLEMENTS` 엣지로 해석합니다(`code-ast` 태그, confidence 가중치).
- **Heuristic track** (Java/Rust를 포함한 모든 언어): 정규식 기반 추출(`code-heuristic` 태그). AST track이 다루지 않는 언어도 커버합니다.

WASM 파서는 순수 JavaScript 의존성이라 네이티브 툴체인이 필요 없습니다. 어떤 이유로든 로드에 실패하면 추출은 heuristic track으로 떨어지고 `AST_UNAVAILABLE` gap을 기록합니다. `TEAMAI_SKIP_AST=1`을 설정하면 heuristic 전용 추출을 강제합니다.

## Team Improvement (beta)

> Every execution makes the entire team smarter.

### Maintenance

Skills와 지식이 쌓이면, 팀이 더 이상 쓰지 않는 것을 정리하세요. `teamai recall maintenance`는 신뢰도가 낮은 learnings를 아카이브하고, 낡은 Skills, Rules, docs를 정리 또는 업데이트 대상으로 표시합니다.

```bash
teamai recall maintenance --prune --dry-run      # preview
teamai recall maintenance --prune --archive      # archive unused learnings
teamai recall maintenance --update-quality       # draft updates for stale skills / docs
```

팀이 AI 도구를 실제로 어떻게 쓰는지 보고, 세션 friction을 공유 Skills, Rules, 지식으로 바꾸는 출발점입니다.

| 기능 | 명령 | 보여주는 것 |
|------------|---------|---------------|
| **Usage** | `teamai digest` | 주간 팀 digest — 7일간의 성공률, prompt, 활성 시간, 추정 비용, cache, 수정 추세와 누적 합계. |
| **Sessions** | `teamai session save` | 개인정보를 제거한 세션별 요약(도구 순서, prompt 턴, 개입)으로 digest의 Session Highlights에 들어갑니다. |
| **Dashboard** | `teamai dashboard` | 실시간 세션과, 직전 7일 대비 로컬 7일 추세를 보여주는 웹 dashboard. |
| **KB Health** | `teamai dashboard` → KB Health | 지식 베이스 사용량과 건강 상태를 보여주는 내장 dashboard 페이지 — 유형별 커버리지, 상위 recall 항목, 침묵 항목, recall 추세, 작성자 기여, maintenance 콘솔. |

## 명령어

| 명령 | 설명 |
|---------|-------------|
| `teamai init` | 초기화: OAuth 로그인, 저장소 연결, 멤버 등록, hooks 주입 |
| `teamai pull` | 팀 리소스를 가져와 로컬 AI 도구에 주입 |
| `teamai push` | 로컬 리소스를 브랜치에 push하고 Merge Request를 엽니다 |
| `teamai packages [install] [target]` | 선언된 npm 패키지와 Claude 플러그인을 설치합니다. target이 있으면 `teamai.yaml`도 갱신합니다. 인자 없는 `teamai packages`는 전부를 설치하고, `teamai packages install <target>`은 하나를 추가합니다 |
| `teamai status` | 로컬과 팀 저장소의 diff 및 리소스 개수(네임스페이스 Skills, 중첩 docs 포함)를 표시 |
| `teamai contribute` | 세션 경험을 팀 저장소의 `teamai-learnings` 브랜치에 공유 |
| `teamai recall <query>` | 팀 지식 베이스 검색 (BM25 + graph-boost) |
| `teamai recall enable/disable/status` | recall 상태를 켜거나 끄거나 확인 |
| `teamai recall promote [learningId]` | 신뢰도가 높은 learning을 정식 지식(skills/rules/docs)으로 승격 |
| `teamai recall maintenance` | 지식 베이스 건강 유지: 신뢰도가 낮은 learnings 정리, confidence 점수 되쓰기, 낡은 항목 표시 |
| `teamai import` | 지식 가져오기 (`--dir`, `--from-repo`, `--from-org`, `--from-repo-list`, `--from-mr`) |
| `teamai codebase --extract [path]` | 코드 사실을 추출하고 `teamwiki/` 아래 로컬 그래프를 구축 |
| `teamai codebase --deep-enrich` | 추출된 evidence로 심층 지식 문서 생성 |
| `teamai codebase --reconcile` | 제품 문서를 추출된 코드 지식과 맞추기 |
| `teamai codebase --lint` | 지식 그래프 건강 검사 |
| `teamai ci extract-mr --url <url>` | CI: MR에서 지식 추출, 댓글 게시, 머지 후 기록 |
| `teamai members` | 팀 멤버 목록 |
| `teamai projects` | 작업 디렉터리를 하나 이상의 논리 프로젝트에 연결 |
| `teamai roles` | 팀 roles와 namespaces 관리 |
| `teamai tags` | 태그 기반 skill/rule 필터 관리 |
| `teamai skill exclude add/remove/list` | 로컬 동기화에서 제외할 Skills 관리 ([usage guide](docs/usage-guide.md#excluding-skills-you-dont-need)) |
| `teamai source` | skill 구독 소스 관리(다른 팀 또는 org의 공유 저장소) |
| `teamai remove <type> <name>` | 리소스를 제거하고 MR을 엽니다 |
| `teamai session save` | 개인정보를 제거한 세션 요약을 월별 로그에 기록 (`--push`는 `digest`에 공급) |
| `teamai digest` | 주간 팀 사용 digest 생성 |
| `teamai doctor` | 구성 문제 진단 (`--json`으로 JSON 출력, CI·hook·agent용) |
| `teamai uninstall` | 모든 teamai 리소스와 hooks 제거 |

## 라이선스

[MIT](LICENSE)

## 기여하기

PR을 환영합니다! 먼저 [CONTRIBUTING.md](.github/CONTRIBUTING.md)를 읽어 주세요.
