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

**รากฐานร่วมสำหรับการทำงาน การเรียนรู้ และการพัฒนาอย่างต่อเนื่องของทีมด้วย AI**

TeamAI เปลี่ยนความสามารถด้าน AI ของแต่ละคนให้เป็นความสามารถร่วมของทีม ใช้ได้ข้าม Agent อุปกรณ์ และสมาชิกในทีม

## ทำไมต้อง TeamAI

<p align="center">
  <img src="assets/use-cases.png" alt="แปดสถานการณ์ในการทำงานจริง ก่อนและหลังใช้ TeamAI" width="100%">
</p>

## เริ่มต้นอย่างรวดเร็ว

ส่งข้อความบรรทัดเดียวนี้ให้ AI ของคุณ:

```text
ช่วยติดตั้ง teamai skill ให้หน่อย: https://github.com/Tencent/teamai-cli/tree/main/skills/teamai , โหลด teamai skill แล้วตั้งค่า TeamAI ให้ทีมของฉันตั้งแต่ต้น
```

เมื่อตั้งค่า TeamAI แล้ว แค่คุยกับ `/teamai` skill ใน AI ของคุณได้เลย:

**ตั้งค่าทีมตั้งแต่ต้น**

```text
/teamai ช่วยตั้งค่า TeamAI ให้ทีมของฉันตั้งแต่ต้น
```

**เข้าร่วมทีม**

```text
/teamai ช่วยพาฉันเข้าร่วม TeamAI ของทีม, URL รีโปคือ https://github.com/your-org/your-repo
```

**แชร์ให้ทีม**

Skills, Rules, MCP และทรัพยากรอื่นที่ Agent ใช้ได้ แชร์ได้ทั้งหมด:

```text
/teamai ช่วยแชร์ xxx skill ให้ทีม
```

**เปิดแดชบอร์ด**

```text
/teamai เปิดแดชบอร์ด TeamAI
```

เมื่อสมาชิกทีมเชื่อมต่อเสร็จแล้ว แค่เปิด Agent ก็ใช้สินทรัพย์ AI ของทีมได้ครบ

<details>
<summary>ติดตั้งด้วยคอมมานด์ไลน์</summary>

### ติดตั้ง

```bash
npm install -g teamai-cli
```

### ผู้ดูแลทีม / ผู้ใช้คนเดียว

สร้างรีโปสำหรับแบ่งปันประสบการณ์บน Git host ของคุณ (GitHub, GitLab, GitCode, CNB, TGit หรือบริการ Git ส่วนตัว) **ให้สิทธิ์เขียนแก่สมาชิกทีม** จากนั้นรัน `teamai init https://github.com/your-org/your-repo`

> **ยังไม่มีรีโปของทีม?** เริ่มจากเทมเพลตที่มี Skills, Rules และ review agents พร้อมใช้จริงอยู่แล้ว เปิดดู org [teamai-hub](https://github.com/teamai-hub) กด **Fork** แล้วรัน `teamai init` กับรีโปใหม่ของคุณ

### สมาชิกทีม

```bash
# Choose one, depending on where you want resources installed

# Project-scope init (default, resources installed under the project directory)
cd /path/to/my-project
teamai init https://github.com/your-org/your-repo

# Or, user-scope init (resources installed under ~/)
teamai init https://github.com/your-org/your-repo --scope user
```

เมื่อเริ่มต้นแล้ว ทุกเซสชัน AI จะดึง Skills / Rules และการอัปเดต Harness อื่นๆ ล่าสุดที่ผู้ดูแลเผยแพร่โดยอัตโนมัติ — ไม่ต้องซิงก์ด้วยตนเอง

</details>

## ภาพรวมผลิตภัณฑ์

สร้างสามชั้นของความสามารถบน Git:

- **Team Execution** — ทำให้ทุก Agent ทำงานตามแนวทางของทีม: skills, rules, docs, env, agents, hooks, MCP
- **Team Context** (beta) — ทำให้ทุก Agent เข้าใจทีม: learnings, กราฟความรู้โค้ดเบส, teamwiki
- **Team Improvement** (beta) — ทำให้ทุกการทำงานยกระดับทีม: usage, sessions, dashboard

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
    <tr><td>GitHub Copilot CLI</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>CodeBuddy</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>WorkBuddy</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>OpenCode</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>Pi Coding Agent</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>OpenClaw</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>Hermes</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>DeepSeek Harness</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>Qoder</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>Qoder CN</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>Kiro</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>ZCode</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>Oh My Pi</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
  </tbody>
</table>

## เรียนรู้เพิ่มเติม

- [Usage Guide](docs/usage-guide.md) — setup, onboarding, daily workflows, and commands
- [Product Overview](docs/product-overview.md) — architecture, distribution controls, and capability details
- [Git Providers](docs/providers.md) — supported repository providers
- [Windows Setup](docs/windows-hooks.md) — hooks and shell configuration
- [Technical Designs](docs/designs/) — design documents and proposals

## ผู้ร่วมพัฒนา

ขอขอบคุณทุกคนที่ได้ร่วมพัฒนา TeamAI!

<a href="https://github.com/Tencent/teamai-cli/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Tencent/teamai-cli" alt="Contributors" />
</a>

สร้างด้วย [contrib.rocks](https://contrib.rocks)

## การร่วมพัฒนา

ยินดีให้เข้าร่วมพูดคุยในชุมชน หรือเปิด Issue และ PR ดูวิธีมีส่วนร่วมได้ที่ [CONTRIBUTING.md](.github/CONTRIBUTING.md)

## ใบอนุญาต

[MIT](LICENSE)
