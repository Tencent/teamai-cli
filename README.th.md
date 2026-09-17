<p align="center">
  <img src="assets/teamai-cli-logo.svg" alt="teamai-cli">
</p>

# TeamAI — Make Every Team AI Native

> [English](README.md) | [中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [ไทย](README.th.md)

[![CI](https://github.com/Tencent/teamai-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Tencent/teamai-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/teamai-cli.svg)](https://www.npmjs.com/package/teamai-cli)
[![npm downloads](https://img.shields.io/npm/dm/teamai-cli.svg)](https://www.npmjs.com/package/teamai-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

TeamAI จัดการ Skills, Rules, MCP และความรู้ของทีมให้ใช้ร่วมกันได้บน Claude Code, Codex, CodeBuddy, WorkBuddy, OpenCode, Cursor และ AI Agents อื่นๆ

## ผู้ร่วมพัฒนา

ขอขอบคุณทุกคนที่ได้ร่วมพัฒนา TeamAI!

<a href="https://trendshift.io/repositories/123184?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-123184" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/123184" alt="Tencent%2Fteamai-cli | Trendshift" width="250" height="55"/></a>

<a href="https://github.com/Tencent/teamai-cli/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Tencent/teamai-cli" alt="Contributors" />
</a>

สร้างด้วย [contrib.rocks](https://contrib.rocks)

## เริ่มต้นอย่างรวดเร็ว

### ติดตั้ง

```bash
npm install -g teamai-cli
```

### ผู้ดูแลทีม / ผู้ใช้คนเดียว

สร้างรีโปสำหรับแบ่งปันประสบการณ์บน Git host ของคุณ (GitHub, GitLab, GitCode, CNB, TGit หรือบริการ Git ส่วนตัว) **ให้สิทธิ์เขียนแก่สมาชิกทีม** จากนั้นรัน `teamai init https://github.com/yourorg/yourrepo`

> **ยังไม่มีรีโปของทีม?** เริ่มจากเทมเพลตที่มี Skills, Rules และ review agents พร้อมใช้จริงอยู่แล้ว เปิดดู org [teamai-hub](https://github.com/teamai-hub) กด **Fork** แล้วรัน `teamai init` กับรีโปใหม่ของคุณ

### สมาชิกทีม

```bash
# Choose one, depending on where you want resources installed

# Project-scope init (default, resources installed under the project directory)
cd /path/to/my-project
teamai init https://github.com/yourorg/yourrepo

# Or, user-scope init (resources installed under ~/)
teamai init https://github.com/yourorg/yourrepo --scope user
```

เมื่อเริ่มต้นแล้ว ทุกเซสชัน AI จะดึง Skills / Rules และการอัปเดต Harness อื่นๆ ล่าสุดที่ผู้ดูแลเผยแพร่โดยอัตโนมัติ — ไม่ต้องซิงก์ด้วยตนเอง

> **คู่มือการใช้งานฉบับเต็ม:** [docs/usage-guide.md](docs/usage-guide.md) ([中文版](docs/usage-guide.zh-CN.md)) — ครอบคลุมตั้งแต่การสร้างทีมไปจนถึงการใช้งานประจำวัน

## สถาปัตยกรรมผลิตภัณฑ์

**Team Execution × Team Context (beta) × Team Improvement (beta)**:

| เลเยอร์ | หน้าที่ | ปัจจุบันใน CLI นี้ |
|-------|-----|-------------------|
| **Team Execution** | ให้ทุก Agent ทำงานตามแบบของทีม | `init` / `pull` / `push`, skills, rules, agents, hooks, MCP, env |
| **Team Context** (beta) | ให้ทุก Agent เข้าใจทีม | recall, learnings, codebase graph, teamwiki... |
| **Team Improvement** (beta) | ให้ทุกครั้งที่ทำงานช่วยพัฒนาทีม | friction-based share-learnings, sessions, digest, dashboard... |

## ภาพรวม

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

**Git providers** — GitHub · GitLab · GitCode · CNB · TGit · บริการ Git ส่วนตัว

### การควบคุมการกระจาย

การตั้งค่าทั้งทีมที่ผู้ดูแลกำหนดครั้งเดียว แล้วส่งถึงสมาชิกทุกคนเมื่อ `teamai pull`:

| ความสามารถ | คำสั่ง | ทำอะไร |
|------------|---------|--------------|
| **Projects** | `teamai projects` | ผูกไดเรกทอรีทำงานกับหนึ่งหรือหลาย logical projects เพื่อซิงก์ Skills ความรู้ และ learnings ที่แยกของโปรเจกต์นั้น ไม่ขึ้นกับ roles |
| **Roles** | `teamai roles` | กำหนดการแมป role → namespace เพื่อให้สมาชิกแต่ละคนซิงก์เฉพาะ Skills ของ role ตนเอง |
| **Tags** | `teamai tags` | ติดแท็ก Skills / Rules เพื่อให้สมาชิกสมัครรับเฉพาะแท็กที่ต้องการ |
| **Sources** | `teamai source` | สมัครรับรีโป Skills เพิ่มเติม — รีโปสาธารณะของทีมอื่น หรือรีโปที่แชร์/สาธารณะใน org ของคุณ Skills ที่สมัครจะซิงก์อัตโนมัติเมื่อ pull |

การแยก learnings: `learnings/` ที่รากรีโปแชร์กับทุกคน; `learnings/<project-id>/` เป็นของโปรเจกต์นั้นโดยเฉพาะ ดู [usage guide](docs/usage-guide.md#multi-project-project-as-a-dimension-orthogonal-to-role)

## Team Execution

> One Team. One Harness. Every Agent.

TeamAI เก็บ Skills, Rules, docs และ hooks ไว้ในรีโป Git ที่ใช้ร่วมกัน แล้วกระจายไปยังเครื่องมือ AI ในเครื่องของสมาชิกทุกคนผ่านโฟลว์ "push → review & merge → pull" — พร้อมรองรับการสมัครรับ Harness จากทีมอื่นหรือรีโปที่แชร์

### วิธีการทำงาน

```
teamai push → create branch + MR → reviewer approves + merges
                                         ↓
              SessionStart hook → teamai pull → synced to local AI tools
```

### สิ่งที่ถูกแชร์

แต่ละทรัพยากรถูกส่งไปยังทุก Agent:

| ทรัพยากร | ในรีโปทีม | หมายเหตุ |
|----------|------------------|-------|
| **Skills** | `skills/<name>/SKILL.md` | |
| **Rules** | `rules/*.md` | |
| **Docs** | `docs/` | เอกสารพื้นฐานของโปรเจกต์; ไม่ได้โหลดทั้งหมดโดยค่าเริ่มต้น (progressive disclosure) |
| **Agents** | `agents/<name>.yaml` | |
| **Culture** | `culture.md` | พันธกิจ ค่านิยม และหลักการทำงานของทีม — ถูกฉีดเข้า CLAUDE.md / AGENTS.md ของแต่ละ Agent เพื่อให้ทุกเซสชันสืบทอดสิ่งเหล่านี้ |
| **CLAUDE.md** | `claudemd/*.md` | |
| **Env** | `env/` | ตัวแปรสภาพแวดล้อมและสวิตช์ระดับทีมที่ใช้ร่วมกัน; อย่าใส่ secrets ที่นี่ |
| **Hooks** | `hooks/hooks.yaml` | แต่ละ hook อาจมี `roles:` เพื่อส่งถึงเฉพาะสมาชิกที่มี role เหล่านั้น |
| **MCP** | `mcp/mcp.yaml` | แต่ละ server อาจมี `roles:` เพื่อส่งถึงเฉพาะสมาชิกที่มี role เหล่านั้น |
| **Packages** | `teamai.yaml` | ขณะนี้รองรับเฉพาะแพ็กเกจ npm และปลั๊กอิน Claude Code |
| **Models** | — | ยังไม่ได้ implement สำหรับทุก provider |

รูปแบบไฟล์และเวิร์กโฟลว์ทั้งหมด ดูที่ [Usage Guide](docs/usage-guide.md)

## Team Context (beta)

> Every agent understands how the team works.

นอกจากการกระจาย Harness แล้ว TeamAI ยังจัดระเบียบประสบการณ์ที่ทีมสะสมและโครงสร้างโค้ดเป็นคลังความรู้ที่ค้นหาได้ ให้ AI เรียกคืนอัตโนมัติเมื่อจำเป็น

### การแชร์ประสบการณ์อัตโนมัติ

เมื่อเซสชันจบ Stop hook จะให้คะแนนตาม **friction** — สัญญาณว่าเซสชันเจอสิ่งที่ควรจดจำ: คุณขัดจังหวะหรือแก้ AI ปฏิเสธการเรียกเครื่องมือ หรือ AI ต้อง retry เครื่องมือที่ล้มเหลว เซสชันที่ยาวแต่เป็นงานประจำ (เรียกเครื่องมือเยอะแต่ไม่มี friction) จะไม่ถูกกระตุ้น ส่วนเซสชันที่คุณสู้กับปัญหาจริงจะถูกกระตุ้น หากคะแนนสูงพอ AI จะแนะนำ:

```
[teamai] This session may contain a problem worth documenting: you interrupted the AI twice, the AI retried failing tools 8 times.

Task: Fix duplicate project-level Hook injection

Consider running /teamai-share-learnings to summarize what you learned and share it with your team.
```

ข้อความแนะนำจะระบุสัญญาณ friction ที่ไม่เป็นศูนย์ซึ่งเป็นตัวกระตุ้น และเมื่อมีข้อมูล จะแนบสรุปบรรทัดเดียวที่ปกปิดข้อมูลอ่อนไหวของงานแรก Skill `/teamai-share-learnings` จะสรุปเซสชันแล้ว push เอกสาร learning ไปยังรีโปทีมโดยตรง แต่ละเซสชันถูกถามอย่างมากหนึ่งครั้ง ทีมสามารถปิดคำแนะนำได้ด้วย `sharing.contributeHint.enabled: false` ใน `teamai.yaml` (สมาชิก: `contributeHintEnabled` ในคอนฟิกท้องถิ่น) โดยยังคงส่วนที่เหลือของ Stop hook

### การเรียกคืนความรู้ทีม

ให้ AI ค้นหาความรู้ที่ทีมสะสมโดยอัตโนมัติก่อนเริ่มงาน ฟีเจอร์นี้ **ปิดโดยค่าเริ่มต้น** และต้องเปิดอย่างชัดเจน — ทีมตั้ง `sharing.recall.enabled: true` ใน `teamai.yaml` เป็นค่าเริ่มต้นได้ และสมาชิกสามารถ override ในเครื่องได้:

```bash
teamai recall enable     # on: deploy the teamai-recall subagent + inject guidance rules
teamai recall disable    # off: remove the subagent and rules
teamai recall status     # show effective state (team default + user override)
```

**การค้นหาทำงานผ่าน subagent**: เมื่อเปิดแล้ว `teamai pull` จะติดตั้ง `teamai-recall` subagent ในตัวไปยังไดเรกทอรี `agents/` ของแต่ละเครื่องมือ AI AI จะเรียกใช้ก่อนเริ่มงาน — subagent สกัดคำสำคัญ รันการค้นหา อ่านไฟล์ต้นทางที่ตรงกัน แล้วคืนสรุปความรู้ทีมแบบมีโครงสร้าง Subagent จะรันการตรวจความเกี่ยวข้องล่วงหน้าก่อน (`teamai recall --check`) และข้ามการดึงข้อมูลทั้งหมดเมื่องานไม่เกี่ยวกับความรู้ทีม เบื้องหลังจะเรียกคำสั่ง `teamai recall` ซึ่งคุณรันเองด้วยมือก็ได้:

```bash
$ teamai recall "port conflict"
[1/2] MR review caught a port-conflict bug ★1 [user]
Author: member-a | Score: 18.5 | Tags: troubleshooting, networking

[2/2] Deployment configuration best practices [project]
Author: member-b | Score: 12.0 | Tags: deploy, config
Matched: conflict | Missing: port
```

### กราฟความรู้ Codebase

`teamai import` แปลงรีโปซอร์สเป็นกราฟมีโครงสร้างภายใต้ `teamwiki/` เพื่อให้ค้นหาโดยคำนึงถึงโครงสร้าง:

```bash
teamai import --from-repo https://github.com/org/repo
teamai import --from-org myorg              # batch import all repos
teamai codebase --extract /path/to/repo     # local extract into teamwiki/
teamai codebase --deep-enrich --project my-service --output /path/to/repo # generate deep knowledge docs
teamai codebase --reconcile --output /path/to/repo # map product docs to code pages
teamai codebase --lint --output /path/to/repo # check the locally extracted graph
```

Extract จะเขียน `teamwiki/evidence/code/<project>/_manifest.json` แม้จะข้าม AI enrichment หรือไม่ได้ผลลัพธ์ เพื่อให้ `--deep-enrich` เริ่มได้

กราฟเก็บ components, interfaces, configs และขอบ import ข้ามรีโป `teamai recall` ใช้กราฟนี้เพื่อจัดอันดับใหม่แบบ graph-boosted
เมื่อผลการ recall มาจากหน้า codebase ผลลัพธ์จะมีบรรทัด `Sources:` ระบุพาธไฟล์ต้นทางที่เกี่ยวข้อง — ให้ Agents มีจุดเริ่มต้นตรงสำหรับแก้โค้ดโดยไม่ต้องสำรวจรีโปใหม่

ขอบมาจากสองแทร็กที่ทำงานคู่กัน โดยผล AST มีลำดับความสำคัญเมื่อซ้อนทับ:

- **AST track** (TypeScript/JavaScript, Python, Go): พาร์เซอร์ WASM [tree-sitter](https://tree-sitter.github.io/) จะ resolve `import`/`require` จุดเรียกใช้ และประโยค `implements` ของ TS เป็นขอบไฟล์ต่อไฟล์แบบ `DEPENDS_ON` / `REFERENCES` / `IMPLEMENTS` ที่แม่นยำ (แท็ก `code-ast` พร้อมน้ำหนักความเชื่อมั่น)
- **Heuristic track** (ทุกภาษา รวม Java/Rust): การ extract ด้วย regex (แท็ก `code-heuristic`) ซึ่งครอบคลุมภาษาที่ AST track ยังไม่รองรับด้วย

พาร์เซอร์ WASM เป็น dependency แบบ pure-JavaScript — ไม่ต้องใช้ native toolchain หากโหลดไม่สำเร็จด้วยเหตุใดก็ตาม การ extract จะถอยไปใช้ heuristic track และบันทึกช่องว่าง `AST_UNAVAILABLE` ตั้ง `TEAMAI_SKIP_AST=1` เพื่อบังคับให้ extract แบบ heuristic อย่างเดียว

## Team Improvement (beta)

> Every execution makes the entire team smarter.

### การบำรุงรักษา

เมื่อ Skills และความรู้สะสมมากขึ้น ให้ตัดสิ่งที่ทีมไม่ใช้แล้ว `teamai recall maintenance` จะ archive learnings ที่ความเชื่อมั่นต่ำ และทำเครื่องหมาย Skills, Rules และ docs ที่ล้าสมัยเพื่อทำความสะอาดหรืออัปเดต:

```bash
teamai recall maintenance --prune --dry-run      # preview
teamai recall maintenance --prune --archive      # archive unused learnings
teamai recall maintenance --update-quality       # draft updates for stale skills / docs
```

ช่วยให้เห็นว่าทีมใช้เครื่องมือ AI จริงอย่างไร และเป็นจุดตั้งต้นในการแปลง friction ของเซสชันเป็น Skills, Rules และความรู้ที่แชร์กัน:

| ความสามารถ | คำสั่ง | สิ่งที่แสดง |
|------------|---------|---------------|
| **Usage** | `teamai digest` | สรุปทีมรายสัปดาห์ — ความสำเร็จใน 7 วัน, prompt, เวลาที่ใช้งาน, ต้นทุนโดยประมาณ, cache และแนวโน้มการแก้ไข รวมถึงยอดสะสมตลอดอายุการใช้งาน |
| **Sessions** | `teamai session save` | สรุปรายเซสชันที่ล้างข้อมูลส่วนตัวแล้ว (ลำดับเครื่องมือ, รอบ prompt, การแทรกแซง) ซึ่งป้อน Session Highlights ของ digest |
| **Dashboard** | `teamai dashboard` | แดชบอร์ดเว็บที่แสดงเซสชันสดและแนวโน้ม 7 วันในเครื่องเทียบกับ 7 วันก่อนหน้า |
| **KB Health** | `teamai dashboard` → KB Health | หน้าในแดชบอร์ดที่รายงานการใช้งานและสุขภาพของคลังความรู้ — ความครอบคลุมตามประเภท, รายการที่ถูก recall บ่อย, รายการที่เงียบ, แนวโน้ม recall, ผลงานของผู้เขียน และคอนโซลบำรุงรักษา |

## คำสั่ง

| คำสั่ง | คำอธิบาย |
|---------|-------------|
| `teamai init` | เริ่มต้น: ล็อกอิน OAuth, เชื่อมรีโป, ลงทะเบียนสมาชิก, ฉีด hooks |
| `teamai pull` | ดึงทรัพยากรทีมแล้วฉีดเข้าเครื่องมือ AI ในเครื่อง |
| `teamai push` | ผลักทรัพยากรในเครื่องไปยังสาขาแล้วเปิด Merge Request |
| `teamai packages [install] [target]` | ติดตั้งแพ็กเกจ npm และปลั๊กอิน Claude ที่ประกาศไว้; ถ้ามี target จะอัปเดต `teamai.yaml` ด้วย `teamai packages` เปล่าติดตั้งทั้งหมด; `teamai packages install <target>` เพิ่มทีละรายการ |
| `teamai status` | แสดงความต่างระหว่างเครื่องกับรีโปทีม และจำนวนทรัพยากร รวมถึง Skills ที่มี namespace และ docs ที่ซ้อนกัน |
| `teamai contribute` | แชร์ประสบการณ์จากเซสชันไปยังแบรนช์ `teamai-learnings` ของรีโปทีม |
| `teamai recall <query>` | ค้นหาคลังความรู้ทีม (BM25 + graph-boost) |
| `teamai recall enable/disable/status` | เปิด/ปิด หรือตรวจสถานะ recall |
| `teamai recall promote [learningId]` | เลื่อน learning ที่ความเชื่อมั่นสูงให้เป็นความรู้ทางการ (skills/rules/docs) |
| `teamai recall maintenance` | ดูแลสุขภาพคลังความรู้: ตัด learnings ที่ความเชื่อมั่นต่ำ, เขียนคะแนนความเชื่อมั่นกลับ, ทำเครื่องหมายรายการที่ล้าสมัย |
| `teamai import` | นำเข้าความรู้ (`--dir`, `--from-repo`, `--from-org`, `--from-repo-list`, `--from-mr`) |
| `teamai codebase --extract [path]` | ดึงข้อเท็จจริงจากโค้ดแล้วสร้างกราฟท้องถิ่นภายใต้ `teamwiki/` |
| `teamai codebase --deep-enrich` | สร้างเอกสารความรู้เชิงลึกจาก evidence ที่ดึงมา |
| `teamai codebase --reconcile` | จับคู่เอกสารผลิตภัณฑ์กับความรู้โค้ดที่ดึงมา |
| `teamai codebase --lint` | ตรวจสุขภาพกราฟความรู้ |
| `teamai ci extract-mr --url <url>` | CI: ดึงความรู้จาก MR, โพสต์คอมเมนต์, เขียนหลัง merge |
| `teamai members` | แสดงรายชื่อสมาชิกทีม |
| `teamai projects` | ผูกไดเรกทอรีทำงานกับหนึ่งหรือหลาย logical projects |
| `teamai roles` | จัดการ roles และ namespaces ของทีม |
| `teamai tags` | จัดการการกรอง skill/rule ตามแท็ก |
| `teamai skill exclude add/remove/list` | จัดการ Skills ที่ไม่ซิงก์ในเครื่อง ([usage guide](docs/usage-guide.md#excluding-skills-you-dont-need)) |
| `teamai source` | จัดการแหล่งสมัคร Skills (ทีมอื่น หรือรีโปที่แชร์ใน org ของคุณ) |
| `teamai remove <type> <name>` | ลบทรัพยากรแล้วเปิด MR |
| `teamai session save` | บันทึกสรุปเซสชันที่ล้างข้อมูลส่วนตัวแล้วลงล็อกรายเดือน (`--push` จะป้อน `digest`) |
| `teamai digest` | สร้างสรุปการใช้งานทีมรายสัปดาห์ |
| `teamai doctor` | วินิจฉัยปัญหาคอนฟิก (`--json` แสดงผลเป็น JSON สำหรับ CI, hook และ agent) |
| `teamai uninstall` | ลบทรัพยากรและ hooks ของ teamai ทั้งหมด |

## ใบอนุญาต

[MIT](LICENSE)

## การร่วมพัฒนา

ยินดีรับ PR! โปรดอ่าน [CONTRIBUTING.md](.github/CONTRIBUTING.md) ก่อน
