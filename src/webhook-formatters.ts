import type { WebhookPayload } from './types.js';

/**
 * Format message for Feishu (Lark) webhook.
 */
export function formatFeishuMessage(payload: WebhookPayload): Record<string, unknown> {
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
export function formatWecomMessage(payload: WebhookPayload): Record<string, unknown> {
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
export function formatGenericJson(payload: WebhookPayload): Record<string, unknown> {
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
function formatEventLabel(event: string): string {
  const labels: Record<string, string> = {
    'push': 'Push Complete',
    'pull': 'Pull Complete',
    'skill-use': 'Skill Used',
    'session-start': 'Session Started',
    'session-stop': 'Session Ended',
    'webhook-test': 'Webhook Test',
  };
  return labels[event] ?? event;
}

/**
 * Format event-specific data for display.
 */
function formatEventData(event: string, data: Record<string, unknown>): string | null {
  switch (event) {
    case 'push':
    case 'pull':
      if (data.resources && typeof data.resources === 'object') {
        const resources = data.resources as Record<string, number>;
        const parts = Object.entries(resources)
          .filter(([, count]) => count > 0)
          .map(([type, count]) => `${type}: ${count}`);
        return parts.length > 0 ? `Resources: ${parts.join(', ')}` : null;
      }
      return null;

    case 'skill-use':
      if (data.skillName && typeof data.skillName === 'string') {
        return `Skill: ${data.skillName}`;
      }
      return null;

    case 'session-start':
    case 'session-stop':
      if (data.sessionId && typeof data.sessionId === 'string') {
        return `Session: ${data.sessionId.slice(0, 8)}...`;
      }
      return null;

    default:
      return null;
  }
}
