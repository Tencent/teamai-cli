import { describe, expect, it } from 'vitest';
import { isUsageLimitText } from './usage-limit.js';

describe('a tool\'s own text for a spent usage limit', () => {
  it.each([
    'You\'ve hit your limit · resets 3pm (Europe/Madrid)',
    '5-hour limit reached ∙ resets 2pm',
    'Claude AI usage limit reached|1762531200',
    'You\'ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again in 2 days 1 hour 40 minutes.',
    'API Error: Request rejected (429) · This request would exceed your account\'s rate limit. Please try again later.',
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit."}}',
    'exceeded retry limit, last status: 429 Too Many Requests, request id: req_1',
    'Rate limit reached for requests per minute.',
  ])('is a usage limit: %s', (text) => {
    expect(isUsageLimitText(text)).toBe(true);
  });

  it.each([
    'Context limit reached: the conversation is too long.',
    'API Error: 401 Invalid bearer token',
    'The reply says you\'ve hit your limit, which is not the tool stopping.',
    'Rate limit reached on the GitHub API, so I used the cached release list.',
  ])('is not a usage limit: %s', (text) => {
    expect(isUsageLimitText(text)).toBe(false);
  });
});
