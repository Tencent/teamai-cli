# Prompt Judge API Guide

> [English](prompt-judge-api-guide.md) | [简体中文](prompt-judge-api-guide.zh-CN.md)

The Prompt Judge API evaluates the quality of a user's prompt for AI coding assistants. It scores prompts across three dimensions — **intent clarity**, **scope specificity**, and **context sufficiency** — returning a 0–10 score for each plus an overall composite score.

The API is served by the TeamAI Dashboard (`teamai dashboard`) and uses the Hunyuan LLM for intelligent scoring. Requires the `HUNYUAN_API_KEY` environment variable to be set.

## Configuration

Set the following environment variables before starting the Dashboard:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HUNYUAN_API_KEY` | Yes | — | API key for Hunyuan LLM service |
| `HUNYUAN_BASE_URL` | No | `https://api.hunyuan.cloud.tencent.com/v1` | Base URL for the Hunyuan API |
| `HUNYUAN_MODEL` | No | `hunyuan-turbos-latest` | Model name to use for scoring |

```bash
export HUNYUAN_API_KEY="your-api-key-here"
teamai dashboard
```

The model configuration is server-side only and is **not exposed** to API callers. Callers only need to send the prompt text.

## Quick Start

1. Start the Dashboard:

```bash
teamai dashboard
# Dashboard running at http://localhost:3721
```

2. Send a prompt for scoring:

```bash
curl -X POST http://localhost:3721/api/judge \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "fix the null pointer in src/utils/session-id.ts line 42"}'
```

3. Response:

```json
{
  "overall": 8,
  "intentClarity": 8,
  "scopeSpecificity": 10,
  "contextSufficiency": 7
}
```

## API Reference

### `POST /api/judge`

Score a single prompt for quality.

**Request**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | `string` | Yes | The prompt text to evaluate |
| `lang` | `string` | No | Language hint: `"zh"` or `"en"`. Auto-detected from CJK character ratio if omitted |

**Response (200 OK)**

| Field | Type | Description |
|-------|------|-------------|
| `overall` | `number` | Composite score (0–10). Weighted: intentClarity × 0.4 + scopeSpecificity × 0.3 + contextSufficiency × 0.3 |
| `intentClarity` | `number` | 0–10. Does the prompt clearly state what action to take? |
| `scopeSpecificity` | `number` | 0–10. Does the prompt specify which files, functions, or modules are involved? |
| `contextSufficiency` | `number` | 0–10. Does the prompt provide enough background (error messages, code snippets, expected behavior)? |
**Error Responses**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{"error": "prompt is required and must be a string"}` | Missing or non-string `prompt` field |
| 400 | `{"error": "invalid JSON body"}` | Malformed JSON in request body |
| 503 | `{"error": "HUNYUAN_API_KEY not configured"}` | `HUNYUAN_API_KEY` environment variable not set |
| 503 | `{"error": "LLM service unavailable"}` | Hunyuan API returned an error or timed out |

## Scoring Dimensions

### Intent Clarity (weight: 40%)

Measures whether the prompt clearly states what the user wants to do.

**Positive signals:**
- Starts with an action verb (`fix`, `add`, `implement`, `refactor`, `debug`, ...) → +3
- Chinese action verbs (`修复`, `添加`, `重构`, `优化`, ...) → +3
- Has a clear objective beyond generic words → +2

**Negative signals:**
- Vague intent with no specific action (e.g., "help me with code") → -3
- Very short prompt (<15 chars / <8 CJK chars) → -3

### Scope Specificity (weight: 30%)

Measures whether the prompt identifies specific code locations.

**Positive signals:**
- Contains a file path (`src/utils/foo.ts`) → +3
- Contains a function or class name (camelCase/PascalCase identifier) → +2
- Contains a line number reference (`:42`, `line 42`) → +1
- Mentions a module or component name → +1

**Negative signals:**
- No file path, function name, or module reference → -3

### Context Sufficiency (weight: 30%)

Measures whether the prompt provides enough background information.

**Positive signals:**
- Contains error keywords (`error`, `bug`, `crash`, `TypeError`, ...) → +2
- Contains a code snippet (backtick-fenced code) → +2
- Describes expected behavior (`should`, `expect`, `supposed to`, ...) → +2
- Length > 100 chars (or > 50 CJK chars) → +1
- Length > 200 chars (or > 100 CJK chars) → +2

**Negative signals:**
- Very short prompt (<15 chars / <8 CJK chars) → -3

## Examples

### High-quality prompt (score: 8–10)

```bash
curl -X POST http://localhost:3721/api/judge \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "Fix the NaN return value in src/recall.ts scoreRelevance() when the corpus array is empty. It should return 0 instead of NaN."
  }'
```

```json
{
  "overall": 10,
  "intentClarity": 8,
  "scopeSpecificity": 10,
  "contextSufficiency": 10
}
```

### Medium-quality prompt (score: 5–7)

```bash
curl -X POST http://localhost:3721/api/judge \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "重构 recall 模块的搜索逻辑"}'
```

```json
{
  "overall": 5,
  "intentClarity": 8,
  "scopeSpecificity": 6,
  "contextSufficiency": 2
}
```

### Low-quality prompt (score: 0–4)

```bash
curl -X POST http://localhost:3721/api/judge \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "帮我改改代码"}'
```

```json
{
  "overall": 2,
  "intentClarity": 2,
  "scopeSpecificity": 2,
  "contextSufficiency": 2
}
```

## Integration Examples

### JavaScript / TypeScript

```javascript
async function judgePrompt(prompt) {
  const resp = await fetch('http://localhost:3721/api/judge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  return resp.json();
}

// Usage
const score = await judgePrompt('fix the bug in src/auth.ts login()');
console.log(`Quality: ${score.overall}/10`);
```

### Python

```python
import requests

def judge_prompt(prompt: str, lang: str = None) -> dict:
    payload = {"prompt": prompt}
    if lang:
        payload["lang"] = lang
    resp = requests.post("http://localhost:3721/api/judge", json=payload)
    resp.raise_for_status()
    return resp.json()

# Usage
score = judge_prompt("修复 src/recall.ts 中 threshold 返回 NaN 的问题")
print(f"Quality: {score['overall']}/10")
```

### Batch Scoring (Shell)

```bash
# Score prompts from a JSONL file
while IFS= read -r line; do
  curl -s -X POST http://localhost:3721/api/judge \
    -H 'Content-Type: application/json' \
    -d "$line"
  echo
done < prompts.jsonl
```

## Dashboard Integration

When the Dashboard is running, prompt scores are automatically computed for each session that has a `promptSummary`. The score appears as a badge in the session card header:

- 8/10 (green) — high quality prompt
- 6/10 (blue) — medium quality prompt
- 3/10 (orange) — needs improvement

Hover over the badge to see the breakdown across all three dimensions.

## API Characteristics

| Property | Value |
|----------|-------|
| Latency | 1–5s (LLM inference via Hunyuan API) |
| Concurrency | Stateless, safe for concurrent calls (Hunyuan default: 5 concurrent) |
| Idempotent | Near-deterministic (temperature=0, minor variance possible) |
| Dependencies | `HUNYUAN_API_KEY` environment variable |
| Accuracy | ~90% agreement with human evaluation |
