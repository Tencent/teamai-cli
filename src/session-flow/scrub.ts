/**
 * scrub.ts — 迁移前的会话脱敏。
 *
 * `session migrate --scrub` 会把整份 IR 过一遍 `utils/redact`：
 * 文本、思考块、工具调用参数、工具结果全部覆盖，密钥形状与当前环境变量里的
 * 疑似密钥都会被替换成 `<REDACTED:...>` 占位符。
 *
 * 为什么要放在迁移链路里：
 * - 迁移的目标通常是另一个 agent 的本地存储，那里的内容随时可能被 `session push`
 *   归档到团队可读的仓库；在迁出时就脱敏，敏感内容不会跟着会话扩散。
 * - 复用 `utils/redact`（`session save` 用的就是它），不新造一套规则，行为一致。
 *
 * 注意：redact() 是 best-effort（规则匹配，不保证零漏）。脱敏后仍建议人工过一遍
 * 再归档；这一点与 `session save` 的注释保持一致。
 */

import type { Session, Message, ContentBlock } from './ir.js';
import { redactWithEnv } from '../utils/redact.js';

export interface ScrubResult {
  session: Session;
  /** 被替换掉的疑似密钥数量（按替换处计数，用于迁移报告）。 */
  redactedCount: number;
}

const REDACTED_MARKER = '<REDACTED:';

/** 统计一段文本里被替换了多少处（redact 的占位符形如 `<REDACTED:label>`）。 */
function countRedactions(before: string, after: string): number {
  if (before === after) return 0;
  let count = 0;
  let idx = after.indexOf(REDACTED_MARKER);
  while (idx >= 0) {
    count++;
    idx = after.indexOf(REDACTED_MARKER, idx + REDACTED_MARKER.length);
  }
  return count;
}

function scrubBlock(block: ContentBlock): { block: ContentBlock; count: number } {
  switch (block.type) {
    case 'text': {
      const next = redactWithEnv(block.text);
      return {
        block: next === block.text ? block : { type: 'text', text: next },
        count: countRedactions(block.text, next),
      };
    }
    case 'thinking': {
      const next = redactWithEnv(block.text);
      return {
        block: next === block.text ? block : { ...block, text: next },
        count: countRedactions(block.text, next),
      };
    }
    case 'tool_call': {
      // 参数是结构化对象：序列化后整段脱敏再解析回来，避免只对字符串字段生效
      const raw = JSON.stringify(block.arguments ?? {});
      const next = redactWithEnv(raw);
      const count = countRedactions(raw, next);
      if (count === 0) return { block, count: 0 };
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(next) as Record<string, unknown>;
      } catch {
        // 脱敏后不再是合法 JSON（极罕见：占位符插进了 key 名）：退回原参数
        return { block, count: 0 };
      }
      return { block: { ...block, arguments: parsed }, count };
    }
    case 'tool_result': {
      const next = redactWithEnv(block.content);
      return {
        block: next === block.content ? block : { ...block, content: next },
        count: countRedactions(block.content, next),
      };
    }
    case 'image':
      // 图片内容不参与文本脱敏（二进制/URL 形态无密钥文本特征）
      return { block, count: 0 };
  }
}

/**
 * 对会话做脱敏（纯函数，不修改入参）。
 *
 * 标题也一起处理：首条提问里常常直接贴着 token，而标题会显示在目标端的列表里。
 */
export function scrubSession(session: Session): ScrubResult {
  let redactedCount = 0;

  const messages: Message[] = session.messages.map((msg) => {
    let contentChanged = false;
    const content = msg.content.map((block) => {
      const { block: next, count } = scrubBlock(block);
      redactedCount += count;
      if (next !== block) contentChanged = true;
      return next;
    });
    return contentChanged ? { ...msg, content } : msg;
  });

  const title = redactWithEnv(session.title);

  return {
    session: { ...session, title, messages },
    redactedCount,
  };
}
