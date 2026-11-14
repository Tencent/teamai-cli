/**
 * Whether `text`, a tool's own error or last message, says it stopped on its usage limit: Claude Code's "You've hit your
 * limit · resets 3pm (Europe/Madrid)", "5-hour limit reached ∙ resets 2pm" or older "Claude AI usage limit
 * reached|<time>", and Codex's "You've hit your usage limit. … try again at 3:04 PM.". A rate limit the model's API
 * answered is one too, retried the same way: Claude Code's "API Error: Request rejected (429) · …" or "API Error: 429
 * {… rate_limit_error …}", Codex's "exceeded retry limit, last status: 429 Too Many Requests", and "Rate limit reached
 * for …". The tool's line starts the text, so a reply that only mentions a limit is not one. Such a failure is
 * `usage_limited`.
 */
export function isUsageLimitText(text: string): boolean {
  return /^(?:you(?:'|’)ve hit your (?:(?:usage|session|weekly|daily|monthly|5-hour) )?limit\b|claude ai usage limit reached\b|(?:5-hour|session|weekly|daily|monthly) limit reached\b|rate limit reached for\b|api error:[^\n]*(?:\b429\b|rate_limit_error)|exceeded retry limit, last status: 429\b)/i.test(text.trim());
}
