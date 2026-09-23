/**
 * 会话标题清洗。
 *
 * 各平台的第一条「用户消息」往往不是人话：CLI 和 IDE 都会往里塞
 * `<system-reminder>`、`<command-name>`、`<memories>` 之类的注入块，
 * 而标题又只能从首条用户消息里取。直接拿来显示，会话列表里就成了
 * 一整段提示词原文——用户看不到自己问了什么，只看到一堆 XML。
 */

/** 标题长度上限：首条用户消息可能是几十 KB 的注入上下文。 */
const TITLE_MAX = 60;

/** 整条消息都是平台注入时，开头会出现这些包裹标签。 */
const INJECTED_HEAD =
  /^\s*<(memories|system-reminder|system|additional_data|local-command-caveat|local-command-stdout|command-name|command-message|command-args|command-contents|agent_requestable_workspace_rules|agent_requestable_user_rules|project_context|project_guidance|teammate-message|user_query|rules)\b/i;

/** 以已知元信息标签开头（用于「剥完仍剩标签」判据）。 */
const META_HEAD_RE =
  /^\s*<(user_info|rules|environment_context|system-reminder|system_reminder|system_instructions|available_skills|agent_request|local-command-caveat|local-command-stdout|uploaded_documents|additional_data|timestamp|command-name|command-message|command-args|command-contents|user_query|memories)\b/i;

const INJECTED_PAIR = /<[a-zA-Z][\w-]*(?:\s[^>]*)?>[\s\S]*?<\/[\w-]+>/g;
const INJECTED_TAG = /<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?\/?>/g;

/**
 * 文本是否整段由平台注入构成。
 *
 * 除了开头标签白名单，还补一条本质判据：剥掉已知元信息块后没剩下内容即视为注入。
 * 否则只维护一份标签清单，`<timestamp>…</timestamp>`、`<user_info>…</user_info>`
 * 这类不在 HEAD 白名单里的整段元信息会被当真实提问，标题就成了提示词原文。
 */
export function isInjectedText(text: string): boolean {
  if (!text || !text.trim()) return true;
  if (INJECTED_HEAD.test(text)) return true;
  const rest = stripMetaBlocks(text).trim();
  if (!rest) return true;
  // 剥完还剩一堆标签：闭合标签被截断（原生数据里就存在 `…</t` 这种半截写法）
  // 时 stripMetaBlocks 匹配不上，整条其实仍是元信息。
  if (META_HEAD_RE.test(text) && /^[<>]|<\/?[a-zA-Z][\w-]*\b[^>]*$/.test(rest)) return true;
  return false;
}

/**
 * 从用户文本候选里解出会话标题（各平台列表/读取侧共用）。
 *
 * 纯文本走标签清洗；注入头开头的整条（`<command-name>…`、`<user_info>…` 等）不能直接
 * 丢弃——slash 命令消息是「注入头 + 真实提问」的混合体，走 titleFromUserText 解
 * `<user_query>` 包裹并剥元信息后，真实提问能救回来。取不到就返回空串，由调用方兜底。
 */
export function titleFromCandidates(candidates: string[]): string {
  for (const text of candidates) {
    if (!text) continue;
    const cleaned = isInjectedText(text)
      ? titleFromUserText(text)
      : cleanTitleText(text) || titleFromUserText(text);
    if (cleaned) return cleaned;
  }
  return '';
}

/**
 * 剥离注入标签后的干净标题。
 *
 * 剥不干净（仍残留尖括号：半截标签、嵌套注入）时返回空串，
 * 让调用方退回 `Session <id>`——宁可难看，也不能把提示词原文当标题。
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

/** 拿不到可用标题时的兜底。 */
export function fallbackTitle(sessionId: string): string {
  return `Session ${sessionId.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// 首条用户消息 → 真实提问（标题 / 列表预览用）
// ---------------------------------------------------------------------------

/**
 * “纯元信息”块：源平台注入的上下文，不是用户输入。
 *
 * 只列纯元信息标签；`<user_query>` 之类包裹真实提问的标签由 extractUserText 单独解包。
 * 不锚定行首：前一块剥离后剩余文本常以 \n\n<rules> 开头，行首锚定会让后续块匹配失败。
 * system_reminder 同时覆盖下划线（CodeBuddy）与连字符（Claude Code）两种写法。
 * command-* / local-command-* 是 Claude Code 的 slash 命令记录（/model 等），
 * 不剥的话「切了个模型」的命令会话标题就成了 `<command-name>/model</command-name>`。
 */
const META_BLOCK_RE =
  /<(user_info|rules|environment_context|system-reminder|system_reminder|system_instructions|available_skills|agent_request|local-command-caveat|local-command-stdout|uploaded_documents|additional_data|timestamp|command-name|command-message|command-args|command-contents)[^>]*>[\s\S]*?<\/\1>[ \t]*\r?\n?/gi;

export function stripMetaBlocks(text: string): string {
  let out = text;
  for (let i = 0; i < 10; i++) {
    const next = out.replace(META_BLOCK_RE, '');
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

/**
 * 从一条用户消息里提取真实用户输入。
 * CodeBuddy / Cursor 会把真实提问包在 <user_query>...</user_query> 里（外层还挂着大段
 * <user_info>/<rules> 元信息），直接取包裹内容最干净；没有该包裹的平台走元信息剥离。
 */
export function extractUserText(text: string): string {
  const m = text.match(/<user_query[^>]*>([\s\S]*?)<\/user_query>/i);
  return stripMetaBlocks(m ? m[1] : text);
}

/** 附件引用（@image:/path、@file:/path）与工具结果占位不是标题素材。 */
const ATTACH_INLINE_RE = /@[A-Za-z_]+:[^\s]+/g;

/**
 * 用户气泡里该显示的正文：元信息块 + 附件引用都不显示，只留真实提问。
 *
 * 各 IDE 会把 `<user_info>` / `<rules>` / `<additional_data>` / `<system_reminder>` 等注入块
 * 和附件路径（`@image:/abs/path`）拼进用户消息，真话则在 `<user_query>` 里。附件路径可能
 * 含空格（如 "Application Support"），而它与正文之间用 2+ 空格分隔，所以按 2+ 空格切段后
 * 丢掉 `@tag:` 开头或绝对路径开头的段。
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
        // 半截附件路径（按空格切断后剩下的片段）
        if (/\.(png|jpe?g|gif|webp|pdf|md|txt|json|jsonl|log)\b/i.test(s) && !/[?？。！!]/.test(s.replace(/\.\w+$/, ''))) {
          return false;
        }
        return true;
      });
    if (segs.length) kept.push(segs.join(' '));
  }
  return kept.join('\n').replace(/[ \t]{2,}/g, ' ').trim();
}
/** 只看「看起来就是路径」的片段：@tag: 开头或绝对路径开头（正文里的 http URL 不算）。 */
const ATTACH_SEG_RE = /^@[A-Za-z_]+:/;
const PATH_SEG_RE = /^(?:[A-Za-z]:)?[/\\]/;
const HYGIENE_RE = /^\[(?:tool_result|image|file|attachment)\b/i;

/**
 * 由首条用户消息得到「像人话」的标题。
 *
 * Cursor 会把附件引用与正文用多空格拼在同一行（路径还可能含空格），所以按 2+ 空格切段、
 * 丢掉「肯定是路径/附件引用」的段（@tag: 开头、绝对路径开头），取第一段正常文本；顺手
 * 跳过工具结果占位。含 URL 的正常句子保留（很多提问正文本身带链接）。
 * 取不到返回空串，由调用方走 fallbackTitle。
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
 * 文本是否值得作为消息渲染。
 *
 * 源平台会把水平线/围栏/空列表项序列化成独立文本块（"-" / "---" / "*" / "```" 等），
 * 它们渲染出来就是一颗颗空 bullet。这类纯 markdown 修饰符块跳过（原文仍保留在
 * response_item / transcript 里，不影响保真度）。
 */
export function isRenderableText(text: string): boolean {
  return /[^\s\-*•·>#`|~_+=()[\]!.,;:?"'\\/0-9—–‘’“”…]/.test(text);
}
