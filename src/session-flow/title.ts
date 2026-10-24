/**
 * Session title cleanup.
 *
 * The first "user message" on each platform is often not human speech: both the CLI and the IDE
 * stuff injected blocks such as `<system-reminder>`, `<command-name>`, and `<memories>` into it,
 * and the title can only be taken from that first user message. Shown as-is, the session list
 * becomes a wall of prompt text — the user cannot see what they asked, only a pile of XML.
 */

/** Title length cap: the first user message may be tens of KB of injected context. */
const TITLE_MAX = 60;

/** Wrapper tags that appear at the start when the whole message is platform-injected. */
const INJECTED_HEAD =
  /^\s*<(memories|system-reminder|system|additional_data|local-command-caveat|local-command-stdout|command-name|command-message|command-args|command-contents|agent_requestable_workspace_rules|agent_requestable_user_rules|project_context|project_guidance|teammate-message|user_query|rules)\b/i;

/** Starts with a known metadata tag (used for the "tags remain after stripping" check). */
const META_HEAD_RE =
  /^\s*<(user_info|rules|environment_context|system-reminder|system_reminder|system_instructions|available_skills|agent_request|local-command-caveat|local-command-stdout|uploaded_documents|additional_data|timestamp|command-name|command-message|command-args|command-contents|user_query|memories)\b/i;

const INJECTED_PAIR = /<[a-zA-Z][\w-]*(?:\s[^>]*)?>[\s\S]*?<\/[\w-]+>/g;
const INJECTED_TAG = /<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?\/?>/g;

/**
 * Whether the text is entirely platform-injected.
 *
 * Besides the leading-tag allowlist, this adds an essential check: if nothing remains after
 * known metadata blocks are stripped, treat it as injected. Otherwise a single tag list would
 * treat whole metadata spans that are not on the HEAD allowlist, such as `<timestamp>…</timestamp>`
 * and `<user_info>…</user_info>`, as a real question, and the title would become raw prompt text.
 */
export function isInjectedText(text: string): boolean {
  if (!text || !text.trim()) return true;
  if (INJECTED_HEAD.test(text)) return true;
  const rest = stripMetaBlocks(text).trim();
  if (!rest) return true;
  // Tags remain after stripping: when a closing tag is truncated (native data contains
  // half-written forms such as `…</t`), stripMetaBlocks fails to match, and the whole
  // message is still metadata.
  if (META_HEAD_RE.test(text) && /^[<>]|<\/?[a-zA-Z][\w-]*\b[^>]*$/.test(rest)) return true;
  return false;
}

/**
 * Derive a session title from user-text candidates (shared by every platform's list/read side).
 *
 * Plain text goes through tag cleanup. A whole message that starts with an injected head
 * (`<command-name>…`, `<user_info>…`, and so on) must not be discarded outright — slash-command
 * messages are a mix of "injected head + real question". titleFromUserText unwraps the
 * `<user_query>` wrapper and strips metadata so the real question can be recovered. If nothing
 * is recovered, return an empty string and let the caller fall back.
 */
export function titleFromCandidates(candidates: string[]): string {
  for (const text of candidates) {
    if (!text) continue;
    // Prefer titleFromUserText for non-injected text too: it unwraps
    // <user_query> and skips placeholder segments ([Image]/attachment paths),
    // so a session whose first message is "[Image] [Image] [Image] <user_query>
    // the real question </user_query>" gets titled by the question, not by the
    // attachments. cleanTitleText stays as the fallback.
    const cleaned = isInjectedText(text)
      ? titleFromUserText(text)
      : titleFromUserText(text) || cleanTitleText(text);
    if (cleaned) return cleaned;
  }
  return '';
}

/**
 * Clean title after injected tags are stripped.
 *
 * If stripping is incomplete (angle brackets remain: truncated tags, nested injection),
 * return an empty string so the caller falls back to `Session <id>` — an ugly fallback is
 * better than using raw prompt text as the title.
 */
export function cleanTitleText(text: string, maxLen = TITLE_MAX): string {
  const stripped = text
    .replace(INJECTED_PAIR, ' ')
    .replace(INJECTED_TAG, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped || /[<>]/.test(stripped)) return '';
  return stripped.slice(0, maxLen);
}

/** Fallback when no usable title can be obtained. */
export function fallbackTitle(sessionId: string): string {
  return `Session ${sessionId.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// First user message → real question (for titles / list previews)
// ---------------------------------------------------------------------------

/**
 * "Pure metadata" blocks: context injected by the source platform, not user input.
 *
 * Only pure metadata tags are listed; tags that wrap a real question, such as `<user_query>`,
 * are unwrapped separately by extractUserText.
 * Not anchored to the start of a line: after an earlier block is stripped, the remainder often
 * starts with \n\n<rules>, and a start-of-line anchor would make later blocks fail to match.
 * system_reminder covers both the underscore form (CodeBuddy) and the hyphen form (Claude Code).
 * command-* / local-command-* are Claude Code slash-command records (/model and the like).
 * If they are not stripped, a "switched the model" command session is titled
 * `<command-name>/model</command-name>`.
 */
const META_BLOCK_RE =
  /<(user_info|rules|environment_context|system-reminder|system_reminder|system_instructions|available_skills|agent_request|local-command-caveat|local-command-stdout|uploaded_documents|additional_data|timestamp|command-name|command-message|command-args|command-contents)[^>]*>[\s\S]*?<\/\1>[ \t]*\r?\n?/gi;

/** The project instructions Codex sends as the first user message, before the member's own words. */
const CODEX_AGENTS_RE = /# AGENTS\.md instructions for [^\n]*\n+<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>[ \t]*\r?\n?/g;

export function stripMetaBlocks(text: string): string {
  let out = text;
  for (let i = 0; i < 10; i++) {
    const next = out.replace(META_BLOCK_RE, '').replace(CODEX_AGENTS_RE, '');
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

/**
 * Extract the real user input from one user message.
 * CodeBuddy / Cursor wrap the real question in <user_query>...</user_query> (with a large
 * <user_info>/<rules> metadata layer outside). Taking the wrapped content is the cleanest;
 * platforms without that wrapper fall back to metadata stripping.
 */
export function extractUserText(text: string): string {
  const m = text.match(/<user_query[^>]*>([\s\S]*?)<\/user_query>/i);
  return stripMetaBlocks(m ? m[1] : text);
}

const COMMAND_RECORD = /^\s*(?:<(command-message|command-name|command-args)>[\s\S]*?<\/\1>\s*)+$/;
const TYPED_COMMAND = /<command-name>(\/[^<\s]+)<\/command-name>(?:\s*<command-args>([\s\S]*?)<\/command-args>)?/;

/**
 * What the member typed in a user message, without the text the tool injected around it, or '' when it holds none.
 * Claude Code keeps a typed `/name args` as a message of only `<command-name>` and `<command-args>` tags.
 */
export function typedText(text: string): string {
  const command = COMMAND_RECORD.test(text) ? TYPED_COMMAND.exec(text) : null;
  return command ? `${command[1]} ${command[2] ?? ''}`.trim() : extractUserText(text);
}

/** The first line the member typed in a user message, as a title. */
export function typedTitle(text: string): string {
  const line = typedText(text).split('\n').map((typed) => typed.replace(/\s+/g, ' ').trim()).find((typed) => typed !== '');
  return line ? line.slice(0, TITLE_MAX) : '';
}

/** Attachment refs (@image:/path, @file:/path) and tool-result placeholders are not title material. */
const ATTACH_INLINE_RE = /@[A-Za-z_]+:[^\s]+/g;

/**
 * Body text that should appear in the user bubble: hide metadata blocks and attachment refs,
 * and keep only the real question.
 *
 * Each IDE concatenates injected blocks such as `<user_info>` / `<rules>` / `<additional_data>` /
 * `<system_reminder>` and attachment paths (`@image:/abs/path`) into the user message; the real
 * words are inside `<user_query>`. Attachment paths may contain spaces (for example
 * "Application Support"), and they are separated from the body by 2+ spaces, so after splitting
 * on 2+ spaces, drop segments that start with `@tag:` or an absolute path.
 */
export function visibleUserText(text: string): string {
  const lines = extractUserText(text).split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const segs = line
      .split(/\s{2,}/)
      .map((s) => s.trim())
      .filter((s) => {
        if (!s) return false;
        if (ATTACH_SEG_RE.test(s) || PATH_SEG_RE.test(s)) return false;
        // Truncated attachment path (the fragment left after splitting on spaces)
        if (/\.(png|jpe?g|gif|webp|pdf|md|txt|json|jsonl|log)\b/i.test(s) && !/[?？。！!]/.test(s.replace(/\.\w+$/, ''))) {
          return false;
        }
        return true;
      });
    if (segs.length) kept.push(segs.join(' '));
  }
  return kept.join('\n').replace(/[ \t]{2,}/g, ' ').trim();
}
/** Only segments that look like paths: starting with @tag: or an absolute path (http URLs in the body do not count). */
const ATTACH_SEG_RE = /^@[A-Za-z_]+:/;
const PATH_SEG_RE = /^(?:[A-Za-z]:)?[/\\]/;
const HYGIENE_RE = /^\[(?:tool_result|image|file|attachment)\b/i;

/**
 * Turn the first user message into a title that reads like human speech.
 *
 * Cursor joins attachment refs and the body on one line with multiple spaces (paths may also
 * contain spaces), so split on 2+ spaces, drop segments that are definitely paths or attachment
 * refs (starting with @tag: or an absolute path), and take the first normal text segment. Tool-result
 * placeholders are skipped along the way. Normal sentences that contain a URL are kept (many
 * questions include a link). If nothing is found, return an empty string and let the caller use
 * fallbackTitle.
 */
export function titleFromUserText(text: string, maxLen = TITLE_MAX): string {
  const cleaned = extractUserText(text).replace(ATTACH_INLINE_RE, ' ');
  for (const line of cleaned.split('\n')) {
    for (const seg of line.split(/\s{2,}/)) {
      const s = seg.replace(/\s+/g, ' ').replace(/^[\s\-:,，。.]+|[\s\-:,，。.]+$/g, '');
      if (!s || s.length < 2 || HYGIENE_RE.test(s)) continue;
      if (ATTACH_SEG_RE.test(s) || PATH_SEG_RE.test(s)) continue;
      return s.slice(0, maxLen);
    }
  }
  return '';
}

/**
 * Whether the text is worth rendering as a message.
 *
 * Source platforms serialize horizontal rules, fences, and empty list items as standalone text
 * blocks ("-" / "---" / "*" / "```", and so on). Rendered, they become empty bullets. Skip these
 * pure markdown-marker blocks (the original text stays in response_item / transcript, so fidelity
 * is unaffected).
 */
export function isRenderableText(text: string): boolean {
  return /[^\s\-*•·>#`|~_+=()[\]!.,;:?"'\\/0-9—–‘’“”…]/.test(text);
}
