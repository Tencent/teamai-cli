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
  /^\s*<(memories|system-reminder|system|additional_data|local-command-caveat|command-name|command-message|command-args|agent_requestable_workspace_rules|agent_requestable_user_rules|project_context|project_guidance|teammate-message|user_query|rules)\b/i;

const INJECTED_PAIR = /<[a-zA-Z][\w-]*(?:\s[^>]*)?>[\s\S]*?<\/[\w-]+>/g;
const INJECTED_TAG = /<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?\/?>/g;

/** 文本是否整段由平台注入构成。 */
export function isInjectedText(text: string): boolean {
  return INJECTED_HEAD.test(text);
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
