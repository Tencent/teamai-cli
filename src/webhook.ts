import { createHmac } from 'node:crypto';
import { autoDetectInit, loadTeamConfig } from './config.js';
import { log } from './utils/logger.js';
import { redactWithEnv } from './utils/redact.js';
import { getWebhookSharing, type LocalConfig, type WebhookEndpoint, type WebhookConfig, type WebhookPayload } from './types.js';
import { formatFeishuMessage, formatWecomMessage, formatGenericJson } from './webhook-formatters.js';

/**
 * Send a webhook notification to all configured endpoints.
 */
export async function sendWebhook(
  event: string,
  payload: Partial<WebhookPayload>,
  config?: WebhookConfig,
): Promise<void> {
  if (!config) {
    const { teamConfig } = await autoDetectInit();
    config = getWebhookSharing(teamConfig);
  }

  if (!config.enabled || config.endpoints.length === 0) return;

  const fullPayload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    tool: payload.tool ?? 'unknown',
    sessionId: payload.sessionId,
    cwd: payload.cwd,
    team: payload.team,
    username: payload.username,
    data: payload.data ?? {},
  };

  const matchingEndpoints = config.endpoints.filter(
    (ep) => ep.events.includes(event) || ep.events.includes('*'),
  );

  if (matchingEndpoints.length === 0) return;

  await Promise.allSettled(
    matchingEndpoints.map((ep) => sendToEndpoint(ep, fullPayload)),
  );
}

/**
 * Send webhook to a single endpoint with retry logic. Resolves to whether the
 * endpoint accepted the event; every failure is logged here and never thrown,
 * so a webhook can never fail the command that fired it.
 */
async function sendToEndpoint(
  endpoint: WebhookEndpoint,
  payload: WebhookPayload,
): Promise<boolean> {
  const { url, type, secret, timeout, retries } = endpoint;

  const body = formatMessage(type, payload);
  const serialized = typeof body === 'string' ? body : JSON.stringify(body);
  // Defense-in-depth: scrub any secret that slipped through the field whitelist
  // before the payload leaves the machine (#701). Route the whole outbound string
  // through the shared redact module rather than hand-masking at the call site.
  const outbound = redactWithEnv(serialized);

  const headers: Record<string, string> = {
    'Content-Type': type === 'json' ? 'application/json' : 'text/plain; charset=utf-8',
  };

  if (secret) {
    // Sign the exact bytes sent so a receiver that verifies the signature over
    // the request body accepts it (#703).
    const signature = createHmac('sha256', secret)
      .update(outbound)
      .digest('hex');
    headers['X-TeamAI-Signature'] = `sha256=${signature}`;
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    let failure: string;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: outbound,
        signal: controller.signal,
      });

      if (response.ok) {
        log.debug(`Webhook sent successfully to ${url}`);
        return true;
      }

      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        log.warn(`Webhook to ${url} failed with status ${response.status} (not retrying)`);
        return false;
      }
      failure = `status ${response.status}`;
    } catch (error) {
      failure = error instanceof Error && error.name === 'AbortError'
        ? `timed out after ${timeout}ms`
        : (error as Error).message;
    } finally {
      clearTimeout(timeoutId);
    }

    if (attempt < retries) {
      const delay = Math.pow(2, attempt) * 1000;
      log.debug(`Webhook to ${url} failed (${failure}), retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    } else {
      log.warn(`Webhook to ${url} failed after ${retries + 1} attempt(s): ${failure}`);
    }
  }
  return false;
}

/**
 * Format message based on webhook type.
 */
function formatMessage(
  type: WebhookEndpoint['type'],
  payload: WebhookPayload,
): string | Record<string, unknown> {
  switch (type) {
    case 'feishu':
      return formatFeishuMessage(payload);
    case 'wecom':
      return formatWecomMessage(payload);
    case 'json':
    default:
      return formatGenericJson(payload);
  }
}

/**
 * Load webhook config from the team config of `localConfig`'s scope, or of the
 * scope detected from the process cwd when none is given.
 */
export async function loadWebhookConfig(localConfig?: LocalConfig): Promise<WebhookConfig> {
  if (!localConfig) return getWebhookSharing((await autoDetectInit()).teamConfig);
  const teamConfig = await loadTeamConfig(localConfig.repo.localPath);
  if (!teamConfig) throw new Error(`No usable team config (teamai.yaml) in ${localConfig.repo.localPath}.`);
  return getWebhookSharing(teamConfig);
}

/**
 * List all configured webhook endpoints.
 */
export async function listWebhooks(): Promise<WebhookEndpoint[]> {
  const config = await loadWebhookConfig();
  return config.endpoints;
}

/**
 * Test webhook by sending a test event.
 */
export async function testWebhook(url?: string): Promise<void> {
  const config = await loadWebhookConfig();

  const endpoints = url
    ? config.endpoints.filter((ep) => ep.url === url)
    : config.endpoints;

  if (endpoints.length === 0) {
    log.warn('No webhook endpoints configured.');
    return;
  }

  const testPayload: WebhookPayload = {
    event: 'webhook-test',
    timestamp: new Date().toISOString(),
    tool: 'teamai-cli',
    data: {
      message: 'This is a test webhook from TeamAI CLI',
    },
  };

  for (const endpoint of endpoints) {
    log.info(`Testing webhook to ${endpoint.url}...`);
    if (await sendToEndpoint(endpoint, testPayload)) {
      log.success(`Webhook test successful: ${endpoint.url}`);
    } else {
      log.error(`Webhook test failed: ${endpoint.url}`);
    }
  }
}
