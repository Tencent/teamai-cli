import { z } from 'zod';
import type { WebhookPayload } from './types.js';

/** A Feishu (Lark) text message body. */
export interface FeishuMessage {
  msg_type: 'text';
  content: { text: string };
}

/** A WeCom (WeChat Work) text message body. */
export interface WecomMessage {
  msgtype: 'text';
  text: { content: string };
}

/** The generic JSON webhook body: the payload's fields as they are. */
export type GenericWebhookMessage = Pick<WebhookPayload, 'event' | 'timestamp' | 'tool' | 'sessionId' | 'cwd' | 'team' | 'username' | 'data'>;

/** Every body a webhook endpoint is sent. */
export type WebhookMessage = FeishuMessage | WecomMessage | GenericWebhookMessage;

/**
 * Format message for Feishu (Lark) webhook.
 */
export function formatFeishuMessage(payload: WebhookPayload): FeishuMessage {
  const eventLabel = formatEventLabel(payload.event);

  const time = new Date(payload.timestamp).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const lines: string[] = [
    `🤖 TeamAI Notification`,
    `━━━━━━━━━━━━━━━━━`,
    `Event: ${eventLabel}`,
  ];

  if (payload.username) {
    lines.push(`User: ${payload.username}`);
  }

  lines.push(`Time: ${time}`);

  if (payload.tool) {
    lines.push(`Tool: ${payload.tool}`);
  }

  if (payload.data) {
    const dataStr = formatEventData(payload.event, payload.data);

    if (dataStr) {
      lines.push(dataStr);
    }
  }

  lines.push(`━━━━━━━━━━━━━━━━━`);

  return {
    msg_type: 'text',
    content: {
      text: lines.join('\n'),
    },
  };
}

/**
 * Format message for WeCom (WeChat Work) webhook.
 */
export function formatWecomMessage(payload: WebhookPayload): WecomMessage {
  const eventLabel = formatEventLabel(payload.event);

  const time = new Date(payload.timestamp).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const lines: string[] = [
    `🤖 TeamAI Notification`,
    `Event: ${eventLabel}`,
  ];

  if (payload.username) {
    lines.push(`User: ${payload.username}`);
  }

  lines.push(`Time: ${time}`);

  if (payload.tool) {
    lines.push(`Tool: ${payload.tool}`);
  }

  if (payload.data) {
    const dataStr = formatEventData(payload.event, payload.data);

    if (dataStr) {
      lines.push(dataStr);
    }
  }

  return {
    msgtype: 'text',
    text: {
      content: lines.join('\n'),
    },
  };
}

/**
 * Format message for generic JSON webhook.
 */
export function formatGenericJson(payload: WebhookPayload): GenericWebhookMessage {
  return {
    event: payload.event,
    timestamp: payload.timestamp,
    tool: payload.tool,
    sessionId: payload.sessionId,
    cwd: payload.cwd,
    team: payload.team,
    username: payload.username,
    data: payload.data,
  };
}

/**
 * Format event label for display.
 */
const EVENT_LABELS = new Map([
  ['push', 'Push Complete'],
  ['pull', 'Pull Complete'],
  ['skill-use', 'Skill Used'],
  ['session-start', 'Session Started'],
  ['session-stop', 'Session Ended'],
  ['webhook-test', 'Webhook Test'],
]);

function formatEventLabel(event: string): string {
  return EVENT_LABELS.get(event) ?? event;
}

/** A push or pull event's count per resource type; a count that is not a number counts as none. */
const ResourceCountsSchema = z.object({ resources: z.record(z.string(), z.number().catch(0)) });

const SkillUseDataSchema = z.object({ skillName: z.string().min(1) });

const SessionDataSchema = z.object({ sessionId: z.string().min(1) });

/**
 * Format event-specific data for display.
 */
function formatEventData(event: string, data: WebhookPayload['data']): string | null {
  switch (event) {
    case 'push':
    case 'pull': {
      const counts = ResourceCountsSchema.safeParse(data);

      if (counts.success) {
        const parts = Object.entries(counts.data.resources).flatMap(([type, count]) => (count > 0 ? [`${type}: ${count}`] : []));

        return parts.length > 0 ? `Resources: ${parts.join(', ')}` : null;
      }

      return null;
    }

    case 'skill-use': {
      const skillUse = SkillUseDataSchema.safeParse(data);

      return skillUse.success ? `Skill: ${skillUse.data.skillName}` : null;
    }

    case 'session-start':
    case 'session-stop': {
      const session = SessionDataSchema.safeParse(data);

      return session.success ? `Session: ${session.data.sessionId.slice(0, 8)}...` : null;
    }

    default:
      return null;
  }
}
