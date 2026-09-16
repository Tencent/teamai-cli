/**
 * fidelity-sweep.test.ts — 跨平台迁移数据保真度扫描（QA 专用，不进 CI）。
 *
 * 构造丰富内容 fixture（多轮对话/中文/代码块/反引号/超长文本>10KB/thinking/
 * tool-call 配对/空 content/emoji/嵌套 JSON/Markdown），对 5 条平台组合做
 * 三腿往返（A 写→读 → B 写→读 → A' 写→读），逐条对比消息条数/role/文本/
 * thinking/tool 配对/时间戳/title/sessionId 稳定性，并核查 fidelityScore 诚实度、
 * flattenDag 多分支行为、500+ 消息压力耗时与内存。
 *
 * 输出 JSON 报告到 /tmp/session-fidelity-report.json（含 diffs 明细）。
 */
import { describe, it, vi, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ home: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = (await importOriginal()) as unknown as Record<string, unknown> & { default?: object };
  const patched: Record<string, unknown> = { ...actual, homedir: () => mocks.home };
  patched.default = { ...(actual.default ?? {}), homedir: () => mocks.home };
  return patched;
});

import { ClaudeCodeAdapter } from '../session-flow/adapters/claude-code.js';
import { CodeBuddyAdapter } from '../session-flow/adapters/codebuddy.js';
import { CodeBuddyIdeAdapter } from '../session-flow/adapters/codebuddy-ide.js';
import { CodexAdapter } from '../session-flow/adapters/codex.js';
import { CursorAdapter } from '../session-flow/adapters/cursor.js';
import { WorkBuddyAdapter } from '../session-flow/adapters/workbuddy.js';
import * as crypto from 'node:crypto';
import { degradeThinkingBlocks, fidelityFromSession } from '../session-flow/migrate.js';
import type { Session, Message } from '../session-flow/ir.js';
import type { AgentAdapter } from '../session-flow/adapters/base.js';
import { encodeCwdClaude } from '../session-flow/fs.js';

// ---------------------------------------------------------------------------
// 报告容器
// ---------------------------------------------------------------------------

const REPORT: Record<string, unknown> = { routes: [], extras: {}, stress: {}, fidelityAudit: [] };
const REPORT_PATH = '/tmp/session-fidelity-report.json';

afterAll(() => {
  fs.writeFileSync(REPORT_PATH, JSON.stringify(REPORT, null, 2), 'utf-8');
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const LONG_10KB =
  '超长内容块测试。This line contains 中文, English, emoji 🚀🔥, backticks ```, quotes "double" \'single\', ' +
  'tabs\tand\nnewlines, JSON {"nested":{"deep":[1,2,{"x":"y"}]}}, markdown **bold** and `inline code`.\n'
    .repeat(120); // ~12KB

function buildFixture(): Session {
  const t = (i: number) => new Date(Date.UTC(2026, 8, 1, 10, 0, i)).toISOString();
  const messages: Message[] = [
    {
      role: 'user',
      timestamp: t(0),
      messageId: 'm0',
      content: [
        {
          type: 'text',
          text: [
            '第一轮提问：请帮我检查下面的代码块（含反引号/中文/emoji 🎉）：',
            '',
            '```python',
            'def foo(s: str) -> str:',
            '    return f"前缀-{s}"  # 注释 "引号" \'单引号\'',
            '```',
            '',
            '特殊字符：\\\\ \t \\u00e9 ¥ € "triple"""\'\'\' <tag> &amp; ${template}',
          ].join('\n'),
        },
        { type: 'text', text: '' }, // 空 text 块
      ],
    },
    {
      role: 'assistant',
      timestamp: t(1),
      messageId: 'm1',
      metadata: { model: 'test-model-x' },
      content: [
        { type: 'thinking', text: '思考：需要先读取配置文件，路径含中文与空格。🤔' },
        { type: 'text', text: '# 分析\n\n- 要点一\n- 要点二 **加粗**\n\n```js\nconst a = 1; // `内嵌反引号`\n```' },
        {
          type: 'tool_call',
          toolName: 'read_file',
          callId: 'call-1',
          arguments: { path: '/x/中文 文件.md', options: { depth: 2, flag: true, tags: ['a', 'b<c>'] } },
        },
      ],
    },
    {
      role: 'user',
      timestamp: t(2),
      messageId: 'm2',
      content: [{ type: 'tool_result', callId: 'call-1', content: LONG_10KB, isError: false }],
    },
    {
      role: 'assistant',
      timestamp: t(3),
      messageId: 'm3',
      content: [
        { type: 'tool_call', toolName: 'bash', callId: 'call-2', arguments: { cmd: 'echo "done" && ls -la' } },
      ],
    },
    {
      role: 'user',
      timestamp: t(4),
      messageId: 'm4',
      content: [{ type: 'tool_result', callId: 'call-2', content: 'boom: exit 1 ❌', isError: true }],
    },
    { role: 'user', timestamp: t(5), messageId: 'm5', content: [{ type: 'text', text: '第二轮提问：总结一下。' }] },
    {
      role: 'assistant',
      timestamp: t(6),
      messageId: 'm6',
      content: [
        { type: 'thinking', text: '思考：用户要总结，要点有三。' },
        { type: 'text', text: '总结 ✅：\n\n1. 配置读取正常\n2. 命令失败已上报\n\n嵌套 JSON：' + JSON.stringify({ a: { b: { c: ['深', '层'] } }, emoji: '🐉' }) },
      ],
    },
    { role: 'user', timestamp: t(7), messageId: 'm7', content: [] }, // 空 content 消息
    {
      role: 'assistant',
      timestamp: t(8),
      messageId: 'm8',
      content: [{ type: 'text', text: LONG_10KB + '\n\n结尾标记 END-OF-LONG ✅' }],
    },
  ];
  return {
    sessionId: 'a1b2c3d4-1111-4222-8333-444455556666',
    title: '保真度扫描 Fixture 🚀 往返测试',
    cwd: '/fixture/proj-a',
    platform: 'fixture',
    createdAt: t(0),
    updatedAt: t(9),
    messages,
    metadata: { model: 'test-model-x' },
  };
}

// ---------------------------------------------------------------------------
// 对比工具
// ---------------------------------------------------------------------------

interface RouteDiff { leg: string; diffs: string[] }

function textOf(msg: Message): string {
  return msg.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
}
function thinkingOf(msg: Message): string {
  return msg.content.filter((b) => b.type === 'thinking').map((b) => (b as { text: string }).text).join('\n');
}
function callsOf(msg: Message): Array<{ toolName: string; callId: string; arguments: unknown }> {
  return msg.content
    .filter((b) => b.type === 'tool_call')
    .map((b) => {
      const c = b as { toolName: string; callId: string; arguments: unknown };
      return { toolName: c.toolName, callId: c.callId, arguments: c.arguments };
    });
}
function resultsOf(msg: Message): Array<{ callId: string; content: string; isError: boolean }> {
  return msg.content
    .filter((b) => b.type === 'tool_result')
    .map((b) => {
      const c = b as { callId: string; content: string; isError: boolean };
      return { callId: c.callId, content: c.content, isError: c.isError };
    });
}

function trunc(s: string, n = 160): string {
  const flat = s.replace(/\n/g, '\\n');
  return flat.length > n ? flat.slice(0, n) + `…(len=${flat.length})` : flat;
}

/**
 * 逐条对比 before → after。expectDegrade=true 时不把 thinking/tool_result 的
 * 平台级降级算作 diff（但 callId 丢失/内容变形仍算）。
 */
function compareSessions(before: Session, after: Session, leg: string, expectDegrade: boolean): RouteDiff {
  const diffs: string[] = [];
  const bm = before.messages;
  const am = after.messages;

  if (bm.length !== am.length) {
    diffs.push(`MESSAGE_COUNT: before=${bm.length} after=${am.length} (delta=${am.length - bm.length})`);
  }

  const n = Math.min(bm.length, am.length);
  for (let i = 0; i < n; i++) {
    const b = bm[i];
    const a = am[i];
    const tag = `msg[${i}](${b.role})`;
    if (b.role !== a.role) diffs.push(`${tag}.ROLE: ${b.role} → ${a.role}`);

    // 文本逐字对比（cursor 会把 tool_result/thinking 降级为 text，单独处理）
    const bt = textOf(b);
    const at = textOf(a);
    if (bt !== at) {
      if (expectDegrade) {
        // 降级后文本 = 原文本 + 包裹前缀，检查原文本是否完整包含于新文本
        const wrapped = bt !== '' && at.includes(bt);
        const degradedOk = a.content.some(
          (blk) => blk.type === 'text' && (blk as { text: string }).text.includes('[tool_result'),
        );
        if (!wrapped || !degradedOk) {
          diffs.push(`${tag}.TEXT_DEGRADED_MISMATCH: before=${trunc(bt)} after=${trunc(at)}`);
        }
      } else {
        diffs.push(`${tag}.TEXT: before=${trunc(bt)} after=${trunc(at)}`);
      }
    }

    // thinking（仅双方都支持时）
    if (!expectDegrade) {
      const bth = thinkingOf(b);
      const ath = thinkingOf(a);
      if (bth !== ath) {
        diffs.push(`${tag}.THINKING: before=${trunc(bth)} after=${trunc(ath)}`);
      }
    }

    // tool_call
    const bc = callsOf(b);
    const ac = callsOf(a);
    if (JSON.stringify(bc) !== JSON.stringify(ac)) {
      diffs.push(`${tag}.TOOL_CALL: before=${JSON.stringify(bc).slice(0, 300)} after=${JSON.stringify(ac).slice(0, 300)}`);
    }

    // tool_result
    const br = resultsOf(b);
    const ar = resultsOf(a);
    if (JSON.stringify(br) !== JSON.stringify(ar)) {
      diffs.push(`${tag}.TOOL_RESULT: before=${JSON.stringify(br).slice(0, 300)} after=${JSON.stringify(ar).slice(0, 300)}`);
    }

    // 时间戳：允许精度损失，不允许错位/反转
    const btMs = b.timestamp ? Date.parse(b.timestamp) : NaN;
    const atMs = a.timestamp ? Date.parse(a.timestamp) : NaN;
    if (!isNaN(btMs) && isNaN(atMs)) diffs.push(`${tag}.TS_LOST: before=${b.timestamp} after=undefined`);
    if (!isNaN(btMs) && !isNaN(atMs)) {
      const drift = atMs - btMs;
      if (drift < -2000) diffs.push(`${tag}.TS_BACKWARD: drift=${drift}ms (before=${b.timestamp} after=${a.timestamp})`);
      else if (drift > 60000) diffs.push(`${tag}.TS_SHIFTED: drift=${drift}ms (before=${b.timestamp} after=${a.timestamp})`);
    }
  }

  // after 内部时间戳单调性
  for (let i = 1; i < am.length; i++) {
    const p = am[i - 1].timestamp ? Date.parse(am[i - 1].timestamp!) : NaN;
    const q = am[i].timestamp ? Date.parse(am[i].timestamp!) : NaN;
    if (!isNaN(p) && !isNaN(q) && q < p - 2000) {
      diffs.push(`TS_NON_MONOTONIC: msg[${i - 1}]→msg[${i}] delta=${q - p}ms`);
      break;
    }
  }

  if (before.title !== after.title) {
    diffs.push(`TITLE: before="${trunc(before.title, 80)}" after="${trunc(after.title, 80)}"`);
  }
  return { leg, diffs };
}

// ---------------------------------------------------------------------------
// 平台沙箱
// ---------------------------------------------------------------------------

let tmpHome = '';

function newWorkspace(name: string): string {
  const dir = path.join(tmpHome, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ideHistoryRoot(): string {
  const root = path.join(
    tmpHome,
    'Library',
    'Application Support',
    'CodeBuddyExtension',
    'Data',
    'ext-x',
    'CodeBuddyIDE',
    'ext-x',
    'history',
  );
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function makeAdapter(platform: string): AgentAdapter {
  switch (platform) {
    case 'claude-code':
      return new ClaudeCodeAdapter('claude-code');
    case 'codebuddy':
      return new CodeBuddyAdapter();
    case 'codebuddy-ide':
      return new CodeBuddyIdeAdapter();
    case 'codex':
      return new CodexAdapter('codex');
    case 'cursor':
      return new CursorAdapter();
    case 'workbuddy':
      return new WorkBuddyAdapter();
    default:
      throw new Error(`unknown platform ${platform}`);
  }
}

// ---------------------------------------------------------------------------
// 路由扫描
// ---------------------------------------------------------------------------

async function sweepRoute(aName: string, bName: string): Promise<void> {
  const A = makeAdapter(aName) as never as AgentAdapter & { readSession: Function; writeSession: Function };
  const B = makeAdapter(bName) as never as AgentAdapter & { readSession: Function; writeSession: Function };
  const cwdA = newWorkspace(`proj-${aName.replace(/[^a-z0-9]/gi, '-')}`);
  const cwdB = newWorkspace(`proj-${bName.replace(/[^a-z0-9]/gi, '-')}`);
  const cwdA2 = newWorkspace(`proj2-${aName.replace(/[^a-z0-9]/gi, '-')}`);

  const fixture = buildFixture();
  const sidA = await (A as any).writeSession(fixture, cwdA);
  const s1 = await (A as any).readSession(sidA, cwdA);

  const enhanced = degradeThinkingBlocks(s1, bName);
  const sidB = await (B as any).writeSession(enhanced, cwdB);
  const s2 = await (B as any).readSession(sidB, cwdB);

  const sidA2 = await (A as any).writeSession(s2, cwdA2);
  const s3 = await (A as any).readSession(sidA2, cwdA2);

  const expectDegrade = bName === 'cursor';
  const leg1 = compareSessions(s1, s2, `${aName}→${bName}`, expectDegrade);
  const leg2 = compareSessions(s2, s3, `${bName}→${aName}`, aName === 'cursor');
  const full = compareSessions(s1, s3, `${aName}→${bName}→${aName}`, false);

  const fid = fidelityFromSession(s1, bName);

  (REPORT.routes as unknown[]).push({
    route: `${aName} → ${bName} → ${aName}`,
    sessionIds: { leg0: sidA, leg1: sidB, leg2: sidA2, stableLeg0to1: sidA === sidB, stableLeg1to2: sidB === sidA2 },
    s1: { messages: s1.messages.length, title: s1.title, cwd: s1.cwd },
    s2: { messages: s2.messages.length, title: s2.title },
    s3: { messages: s3.messages.length, title: s3.title },
    fidelityScoreAtSource: { score: Number(fid.score.toFixed(4)), degraded: fid.degradedBlocks, warnings: fid.warnings, platformSpecificLosses: fid.platformSpecificLosses },
    leg1,
    leg2,
    full,
  });
}

describe('fidelity sweep (QA, writes report to /tmp/session-fidelity-report.json)', () => {
  it('runs all 5 roundtrip routes', async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-fidelity-'));
    mocks.home = tmpHome;
    ideHistoryRoot();
    try {
      await sweepRoute('codebuddy-ide', 'claude-code');
      await sweepRoute('codebuddy', 'claude-code');
      await sweepRoute('claude-code', 'cursor');
      await sweepRoute('workbuddy', 'claude-code');
      await sweepRoute('codex', 'claude-code');
    } finally {
      mocks.home = '';
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 120_000);

  // -------------------------------------------------------------------------

  it('flattenDag: multi-branch + sidechain behavior', async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-fidelity-dag-'));
    mocks.home = tmpHome;
    try {
      const cwd = newWorkspace('dag-proj');
      const ts = '2026-09-01T10:00:00.000Z';
      const rec = (uuid: string, parentUuid: string | null, text: string, extra: Record<string, unknown> = {}) => ({
        parentUuid,
        isSidechain: false,
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        uuid,
        timestamp: ts,
        cwd,
        sessionId: 'dag00000-0000-4000-8000-000000000000',
        version: '2.1.221',
        userType: 'external',
        entrypoint: 'cli',
        ...extra,
      });
      const records = [
        rec('u1', null, 'Q1'),
        { ...rec('a1', 'u1', 'A1'), type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'A1' }] } },
        rec('u2', 'a1', 'Q2-main'), // 主线分叉
        { ...rec('a1b', 'a1', 'A1-branch2'), type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'A1-branch2' }] } }, // 文件序在 u2 之后
        rec('side1', 'a1', 'SIDECHAIN-Q', { isSidechain: true }), // 侧链
        { ...rec('a2', 'u2', 'A2'), type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'A2' }] } },
        // 孤儿节点：parentUuid 指向不存在记录
        rec('orphan', 'ghost-uuid', 'ORPHAN-Q'),
      ];
      const adapter = new ClaudeCodeAdapter('claude-code');
      // 直接写入编码目录（必须复用适配器编码逻辑：macOS /var → /private/var realpath）
      const dir = path.join(tmpHome, '.claude', 'projects', encodeCwdClaude(cwd));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'dag00000-0000-4000-8000-000000000000.jsonl'),
        records.map((r) => JSON.stringify(r)).join('\n') + '\n',
      );

      const session = (await (adapter as any).readSession('dag00000-0000-4000-8000-000000000000', cwd)) as Session;
      const outline = session.messages.map((m) => `${m.role}:${textOf(m)}`);
      (REPORT.extras as Record<string, unknown>).flattenDag = {
        expectedFileOrder: ['user:Q1', 'assistant:A1', 'user:Q2-main', 'assistant:A1-branch2', 'user:SIDECHAIN-Q', 'assistant:A2', 'user:ORPHAN-Q'],
        actualReadOrder: outline,
        sidechainDropped: !outline.some((o) => o.includes('SIDECHAIN-Q')),
        branchInterleaved: outline.indexOf('assistant:A1-branch2') > -1 && outline.indexOf('assistant:A1-branch2') < outline.indexOf('assistant:A2'),
        orphanKept: outline.some((o) => o.includes('ORPHAN-Q')),
      };
    } finally {
      mocks.home = '';
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------

  it('fidelityScore honesty audit', async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-fidelity-f-'));
    mocks.home = tmpHome;
    ideHistoryRoot();
    try {
      const audit = REPORT.fidelityAudit as Array<Record<string, unknown>>;
      const mk = (name: string, adapter: any, read: () => Promise<Session>, target = 'claude-code') =>
        read().then((s) => {
          const fid = fidelityFromSession(s, target);
          audit.push({
            case: name,
            score: Number(fid.score.toFixed(4)),
            degradedBlocks: fid.degradedBlocks,
            lostBlocks: fid.lostBlocks,
            warnings: fid.warnings,
            platformSpecificLosses: fid.platformSpecificLosses,
            messageCount: s.messages.length,
          });
          return s;
        });

      // F1: IDE 侧图片块（IR 无对应类型）被静默丢弃 → score 仍 1.0
      const ide = new CodeBuddyIdeAdapter();
      const cwd = newWorkspace('f1-proj');
      const root = ideHistoryRoot();
      const convId = 'f1111111111111111111111111111111';
      const wsDir = path.join(root, crypto.createHash('md5').update(fs.realpathSync(cwd)).digest('hex'));
      const msgDir = path.join(wsDir, convId, 'messages');
      fs.mkdirSync(msgDir, { recursive: true });
      const msgs = [
        { id: 'u1', role: 'user', content: [{ type: 'text', text: '看这张图' }] },
        { id: 'a1', role: 'assistant', content: [{ type: 'image', data: 'BASE64-PICTURE-DATA' }, { type: 'text', text: '图已收到' }] },
      ];
      fs.writeFileSync(path.join(wsDir, convId, 'index.json'), JSON.stringify({ messages: msgs.map((m) => ({ id: m.id })), requests: [] }));
      msgs.forEach((m) =>
        fs.writeFileSync(
          path.join(msgDir, `${m.id}.json`),
          JSON.stringify({ role: m.role, message: JSON.stringify({ role: m.role, content: m.content }), id: m.id, extra: '{}', createdAt: '2026-09-01T10:00:00.000Z' }),
        ),
      );
      fs.writeFileSync(path.join(wsDir, 'index.json'), JSON.stringify({ conversations: [{ id: convId, type: 'craft', name: 'F1', createdAt: '2026-09-01T10:00:00.000Z', lastMessageAt: '2026-09-01T10:00:00.000Z' }] }));
      await mk('F1 codebuddy-ide image block silently dropped', ide, () => ide.readSession(convId, cwd));

      // F2: 空 content 消息被多平台写入端静默丢弃（score 按 block 计，看不见消息级丢失）
      const fixtureEmpty = buildFixture();
      const cursor = new CursorAdapter();
      const claude = new ClaudeCodeAdapter('claude-code');
      const fidEmpty = fidelityFromSession(fixtureEmpty, 'cursor');
      audit.push({ case: 'F2 fixture(empty msg) fidelity→cursor', score: Number(fidEmpty.score.toFixed(4)), note: '空消息 0 block，不扣分；但 cursor.writeSession 会静默丢弃该消息' });

      // F3: claude sidechain 在 readSession 拍平时已丢，fidelity 输入侧就看不到
      audit.push({ case: 'F3 claude sidechain', note: 'fidelity 在 readSession 之后计算，sidechain/孤儿分支的块不进入 IR，永远不计入损失' });

      // F4: cursor 作为目标时 tool_result 降级是否被正确计分
      const fidCursor = fidelityFromSession(buildFixture(), 'cursor');
      audit.push({ case: 'F4 fixture fidelity→cursor', score: Number(fidCursor.score.toFixed(4)), degradedBlocks: fidCursor.degradedBlocks, platformSpecificLosses: fidCursor.platformSpecificLosses });
      void cursor; void claude;
    } finally {
      mocks.home = '';
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------

  it('stress: 600-message session migrate timing + memory', async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-fidelity-stress-'));
    mocks.home = tmpHome;
    try {
      const cwd = newWorkspace('stress-proj');
      const messages: Message[] = [];
      for (let i = 0; i < 300; i++) {
        messages.push({
          role: 'user',
          timestamp: new Date(Date.UTC(2026, 8, 1, 8, 0, i * 2)).toISOString(),
          messageId: `su${i}`,
          content: [
            { type: 'text', text: `压力测试第 ${i} 轮提问 🚀：${'内容填充'.repeat(20)}` },
            { type: 'tool_result', callId: `sc-${i}`, content: `result-${i}-${'x'.repeat(500)}`, isError: i % 7 === 0 },
          ],
        });
        messages.push({
          role: 'assistant',
          timestamp: new Date(Date.UTC(2026, 8, 1, 8, 0, i * 2 + 1)).toISOString(),
          messageId: `sa${i}`,
          content: [
            { type: 'thinking', text: `思考 ${i}` },
            { type: 'text', text: `回答 ${i}：${'分析'.repeat(30)}` },
            { type: 'tool_call', toolName: 'bash', callId: `sc-${i}`, arguments: { cmd: `echo ${i}` } },
          ],
        });
      }
      const session: Session = {
        sessionId: 'b1b2c3d4-1111-4222-8333-444455556666',
        title: '压力测试 600 消息',
        cwd,
        platform: 'fixture',
        createdAt: messages[0].timestamp!,
        updatedAt: messages[messages.length - 1].timestamp!,
        messages,
      };

      const mem0 = process.memoryUsage();
      const claude = new ClaudeCodeAdapter('claude-code');
      let t0 = Date.now();
      void claude.writeSession(session, cwd);
      const claudeWriteMs = Date.now() - t0;
      t0 = Date.now();
      const back = (await claude.readSession(session.sessionId, cwd)) as Session;
      const claudeReadMs = Date.now() - t0;

      const codex = new CodexAdapter('codex');
      t0 = Date.now();
      // 注意：codex.writeSession 对非 UUIDv7 的 id 会重新生成 —— 这里本就是一个发现
      const stressSid = (await codex.writeSession(session, cwd)) as string;
      const codexWriteMs = Date.now() - t0;
      t0 = Date.now();
      await codex.readSession(stressSid);
      const codexReadMs = Date.now() - t0;

      const mem1 = process.memoryUsage();
      REPORT.stress = {
        messageCount: session.messages.length,
        claudeWriteMs,
        claudeReadMs,
        codexWriteMs,
        codexReadMs,
        claudeReadBackMessages: back.messages.length,
        heapDeltaMB: Number(((mem1.heapUsed - mem0.heapUsed) / 1048576).toFixed(1)),
        rssMB: Number((mem1.rss / 1048576).toFixed(1)),
      };
    } finally {
      mocks.home = '';
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 180_000);
});
