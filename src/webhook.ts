import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { autoDetectInit, loadTeamConfig } from './config.js';
import { log } from '@teamai/shared/log';
import { redactWithEnv } from '@teamai/shared/redact';
import { getWebhookSharing, type LocalConfig, type WebhookEndpoint, type WebhookConfig, type WebhookPayload } from './types.js';
import { formatFeishuMessage, formatWecomMessage, formatGenericJson, type WebhookMessage } from './webhook-formatters.js';

/**
 * Send a webhook notification to all configured endpoints.
 */
export async function sendWebhook(
  event: string,
  payload: Partial<WebhookPayload>,
  config?: WebhookConfig,
): Promise<void> {
  if (!config) {
    // oxlint-disable-next-line teamai/config-load-options -- notification sending retains normal config migration and has no preview option
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
  const serialized = JSON.stringify(body);
  // Defense-in-depth: scrub any secret that slipped through the field whitelist
  // before the payload leaves the machine (#701). Route the whole outbound string
  // through the shared redact module rather than hand-masking at the call site.
  const outbound = redactWithEnv(serialized);

  // Feishu and WeCom custom bots require a JSON body; every formatMessage()
  // branch produces JSON. text/plain made those endpoints reject the payload.
  const headerEntries: [string, string][] = [
    ['Content-Type', 'application/json; charset=utf-8'],
  ];

  if (secret) {
    // Sign the exact bytes sent so a receiver that verifies the signature over
    // the request body accepts it (#703).
    const signature = createHmac('sha256', secret)
      .update(outbound)
      .digest('hex');

    headerEntries.push(['X-TeamAI-Signature', `sha256=${signature}`]);
  }

  const headers = Object.fromEntries(headerEntries);

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
        // Feishu and WeCom acknowledge with HTTP 200 even on business-level
        // rejection (bad token, rate limit, invalid payload) and put the real
        // outcome in the JSON body. Treat a non-zero code as a delivery failure
        // so it is logged and retried instead of silently reported as success.
        const rejection = await businessRejection(type, response);

        if (rejection === undefined) {
          log.debug(`Webhook sent successfully to ${url}`);

          return true;
        }

        failure = rejection;
      } else if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        log.warn(`Webhook to ${url} failed with status ${response.status} (not retrying)`);

        return false;
      } else {
        failure = `status ${response.status}`;
      }
    } catch (error) {
      failure = error instanceof Error && error.name === 'AbortError'
        ? `timed out after ${timeout}ms`
        : error instanceof Error ? error.message : String(error);
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
 * Business-level rejection carried in an HTTP 200 response body. Feishu uses
 * `{ code, msg }` (0 = ok), WeCom uses `{ errcode, errmsg }` (0 = ok). Both are
 * documented to answer 200 on failures such as invalid credentials, rate
 * limits and bad message types. Returns a description of the rejection, or
 * undefined when the endpoint accepted the event (or its body is not a
 * machine-readable rejection we understand).
 *
 * Parsing is deliberately best-effort: a webhook must never fail the command
 * that fired it, so an unreadable/non-JSON body is treated as accepted.
 */
const FeishuAck = z.object({ code: z.number(), msg: z.string().optional() });
const WecomAck = z.object({ errcode: z.number(), errmsg: z.string().optional() });

export async function businessRejection(
  type: WebhookEndpoint['type'],
  response: Response,
): Promise<string | undefined> {
  if (type === 'json') return undefined;

  // Parse at the I/O boundary with a schema so malformed/foreign bodies never
  // reach a `typeof` narrowing. A body that is not readable or not the expected
  // shape is not a machine-readable rejection: treat it as accepted (fail soft).
  let body: unknown;

  try {
    body = await response.json();
  } catch {
    return undefined;
  }

  if (type === 'feishu') {
    const ack = FeishuAck.safeParse(body);

    return ack.success && ack.data.code !== 0
      ? `business code ${ack.data.code}${ack.data.msg ? `: ${ack.data.msg}` : ''}`
      : undefined;
  }

  const ack = WecomAck.safeParse(body);

  return ack.success && ack.data.errcode !== 0
    ? `business code ${ack.data.errcode}${ack.data.errmsg ? `: ${ack.data.errmsg}` : ''}`
    : undefined;
}

/**
 * Format message based on webhook type.
 */
function formatMessage(
  type: WebhookEndpoint['type'],
  payload: WebhookPayload,
): WebhookMessage {
  switch (type) {
    case 'feishu':
      return formatFeishuMessage(payload);
    case 'wecom':
      return formatWecomMessage(payload);
    default:
      return formatGenericJson(payload);
  }
}

/**
 * Load webhook config from the team config of `localConfig`'s scope, or of the
 * scope detected from the process cwd when none is given.
 */
export async function loadWebhookConfig(
  localConfig?: LocalConfig,
  options: { dryRun?: boolean } = {},
): Promise<WebhookConfig> {
  if (!localConfig) return getWebhookSharing((await autoDetectInit(undefined, options)).teamConfig);
  const teamConfig = await loadTeamConfig(localConfig.repo.localPath, localConfig);

  if (!teamConfig) throw new Error(`No usable team config (teamai.yaml) in ${localConfig.repo.localPath}.`);

  return getWebhookSharing(teamConfig);
}

/**
 * List all configured webhook endpoints.
 */
export async function listWebhooks(): Promise<WebhookEndpoint[]> {
  // Read-only: the load never persists a migration (#893).
  return (await loadWebhookConfig(undefined, { dryRun: true })).endpoints;
}

/**
 * Test webhook by sending a test event.
 */
export async function testWebhook(url?: string, options: { dryRun?: boolean } = {}): Promise<void> {
  const config = await loadWebhookConfig(undefined, { dryRun: options.dryRun });

  const endpoints = url
    ? config.endpoints.filter((ep) => ep.url === url)
    : config.endpoints;

  if (options.dryRun) {
    log.info(`[dry-run] Would send a test webhook to ${endpoints.length} endpoint(s).`);

    return;
  }

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
      process.exitCode = 1;
    }
  }
}
