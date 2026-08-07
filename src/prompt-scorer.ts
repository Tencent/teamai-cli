/**
 * LLM-based prompt quality scorer using Hunyuan API.
 *
 * Evaluates a user's first prompt across three dimensions:
 * intentClarity, scopeSpecificity, contextSufficiency.
 * Calls Hunyuan (OpenAI-compatible) chat completions endpoint.
 */

import { type PromptScore } from './types.js';

export { type PromptScore };

const DEFAULT_BASE_URL = 'https://api.hunyuan.cloud.tencent.com/v1';
const DEFAULT_MODEL = 'hunyuan-turbos-latest';
const FETCH_TIMEOUT_MS = 10_000;

const SCORING_SYSTEM_PROMPT = `You are an AI coding assistant prompt quality evaluator.
Score the given user prompt across three dimensions (each 0-10):

1. intentClarity: Is the user's goal clear? Action verb + specific target = high score.
2. scopeSpecificity: Does the prompt specify which files, functions, or modules? File paths, function names = high score.
3. contextSufficiency: Does the prompt provide enough background? Error messages, code snippets, expected behavior = high score.

Respond with ONLY a JSON object (no markdown, no explanation):
{"overall": N, "intentClarity": N, "scopeSpecificity": N, "contextSufficiency": N}

overall = round(intentClarity * 0.4 + scopeSpecificity * 0.3 + contextSufficiency * 0.3)`;

/** Score a prompt using the Hunyuan LLM API. */
export async function scorePrompt(prompt: string, lang?: string): Promise<PromptScore> {
  const apiKey = process.env.HUNYUAN_API_KEY;
  if (!apiKey) {
    throw new Error('HUNYUAN_API_KEY not configured');
  }

  const baseUrl = process.env.HUNYUAN_BASE_URL ?? DEFAULT_BASE_URL;
  const model = process.env.HUNYUAN_MODEL ?? DEFAULT_MODEL;
  const url = `${baseUrl}/chat/completions`;

  const langHint = lang ? ` The prompt is in ${lang === 'zh' ? 'Chinese' : 'English'}.` : '';
  const userContent = `${langHint}\n\nUser prompt to evaluate:\n"""\n${prompt}\n"""`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SCORING_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        temperature: 0,
        max_tokens: 100,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Hunyuan API error: ${response.status} ${text.slice(0, 200)}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    return parseScoreResponse(content);
  } finally {
    clearTimeout(timer);
  }
}

/** Parse the LLM JSON response into a PromptScore. */
function parseScoreResponse(content: string): PromptScore {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Failed to parse LLM response: no JSON found in "${content.slice(0, 200)}"`);
  }

  const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  const intentClarity = clampScore(parsed.intentClarity);
  const scopeSpecificity = clampScore(parsed.scopeSpecificity);
  const contextSufficiency = clampScore(parsed.contextSufficiency);
  const overall = Math.round(intentClarity * 0.4 + scopeSpecificity * 0.3 + contextSufficiency * 0.3);

  return { overall, intentClarity, scopeSpecificity, contextSufficiency };
}

function clampScore(value: unknown): number {
  const n = Number(value);
  if (Number.isNaN(n)) return 5;
  return Math.max(0, Math.min(10, Math.round(n)));
}
