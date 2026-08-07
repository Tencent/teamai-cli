# Prompt 评分 API 使用指南

> [English](prompt-judge-api-guide.md) | [简体中文](prompt-judge-api-guide.zh-CN.md)

Prompt Judge API 用于评估 AI 编码助手用户 prompt 的质量。它从三个维度打分——**意图清晰度**、**范围明确性**、**上下文充分度**——每项返回 0–10 分以及一个综合评分。

该 API 由 TeamAI Dashboard（`teamai dashboard`）提供服务，使用混元（Hunyuan）大模型进行智能评分。需要设置 `HUNYUAN_API_KEY` 环境变量。

## 配置

启动 Dashboard 前设置以下环境变量：

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `HUNYUAN_API_KEY` | 是 | — | 混元 LLM 服务的 API key |
| `HUNYUAN_BASE_URL` | 否 | `https://tokenhub.tencentmaas.com/v1` | 混元 API 的 Base URL |
| `HUNYUAN_MODEL` | 否 | `hy3` | 用于评分的模型名称 |

```bash
export HUNYUAN_API_KEY="your-api-key-here"
teamai dashboard
```

模型配置仅在服务端使用，**不会暴露**给 API 调用者。调用者只需发送 prompt 文本即可。

## 快速开始

1. 启动 Dashboard：

```bash
teamai dashboard
# Dashboard running at http://localhost:3721
```

2. 发送 prompt 进行评分：

```bash
curl -X POST http://localhost:3721/api/judge \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "修复 src/utils/session-id.ts 第 42 行的空指针问题"}'
```

3. 响应：

```json
{
  "overall": 8,
  "intentClarity": 8,
  "scopeSpecificity": 10,
  "contextSufficiency": 5
}
```

## API 参考

### `POST /api/judge`

对单个 prompt 进行质量评分。

**请求参数**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | `string` | 是 | 待评分的 prompt 文本 |
| `lang` | `string` | 否 | 语言提示：`"zh"` 或 `"en"`。未传时根据 CJK 字符占比自动检测 |

**成功响应 (200 OK)**

| 字段 | 类型 | 说明 |
|------|------|------|
| `overall` | `number` | 综合评分（0–10）。加权计算：intentClarity × 0.4 + scopeSpecificity × 0.3 + contextSufficiency × 0.3 |
| `intentClarity` | `number` | 意图清晰度（0–10）。prompt 是否明确表达了要做什么？ |
| `scopeSpecificity` | `number` | 范围明确性（0–10）。prompt 是否指定了涉及的文件、函数或模块？ |
| `contextSufficiency` | `number` | 上下文充分度（0–10）。prompt 是否提供了足够的背景信息（错误信息、代码片段、期望行为）？ |
**错误响应**

| 状态码 | 响应体 | 原因 |
|--------|-------|------|
| 400 | `{"error": "prompt is required and must be a string"}` | 缺少 `prompt` 字段或类型不是字符串 |
| 400 | `{"error": "invalid JSON body"}` | 请求体 JSON 格式错误 |
| 503 | `{"error": "HUNYUAN_API_KEY not configured"}` | 未设置 `HUNYUAN_API_KEY` 环境变量 |
| 503 | `{"error": "LLM service unavailable"}` | 混元 API 返回错误或超时 |

## 评分维度

### 意图清晰度 (Intent Clarity)，权重 40%

衡量 prompt 是否清楚地表达了用户想做什么。

**加分信号：**
- 以动作动词开头（`fix`、`add`、`implement`、`refactor`、`debug`…）→ +3
- 中文动作动词（`修复`、`添加`、`重构`、`优化`…）→ +3
- 有明确的目标对象（不仅仅是泛指） → +2

**减分信号：**
- 意图模糊，无具体动作（如"帮我弄弄代码"）→ -3
- 极短 prompt（<15 字符 / <8 个汉字）→ -3

### 范围明确性 (Scope Specificity)，权重 30%

衡量 prompt 是否指定了具体的代码位置。

**加分信号：**
- 包含文件路径（`src/utils/foo.ts`）→ +3
- 包含函数或类名（camelCase/PascalCase 标识符）→ +2
- 包含行号引用（`:42`、`line 42`）→ +1
- 提到了模块或组件名 → +1

**减分信号：**
- 无文件路径、函数名或模块引用 → -3

### 上下文充分度 (Context Sufficiency)，权重 30%

衡量 prompt 是否提供了足够的背景信息。

**加分信号：**
- 包含错误关键词（`error`、`bug`、`crash`、`TypeError`…）→ +2
- 包含代码片段（backtick 包裹的代码）→ +2
- 描述了期望行为（`应该`、`期望`、`should`、`expect`…）→ +2
- 长度 >100 字符（或 >50 个汉字）→ +1
- 长度 >200 字符（或 >100 个汉字）→ +2

**减分信号：**
- 极短 prompt（<15 字符 / <8 个汉字）→ -3

## 使用示例

### 高质量 prompt（评分 8–10）

```bash
curl -X POST http://localhost:3721/api/judge \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "修复 src/recall.ts 中 scoreRelevance() 在 corpus 数组为空时返回 NaN 的问题，应该返回 0"
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

### 中等质量 prompt（评分 5–7）

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

### 低质量 prompt（评分 0–4）

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

## 集成示例

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

// 使用
const score = await judgePrompt('修复 src/auth.ts 中 login() 的 bug');
console.log(`质量评分: ${score.overall}/10`);
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

# 使用
score = judge_prompt("修复 src/recall.ts 中 threshold 返回 NaN 的问题")
print(f"质量评分: {score['overall']}/10")
```

### 批量评分 (Shell)

```bash
# 从 JSONL 文件批量评分
while IFS= read -r line; do
  curl -s -X POST http://localhost:3721/api/judge \
    -H 'Content-Type: application/json' \
    -d "$line"
  echo
done < prompts.jsonl
```

## Dashboard 集成

Dashboard 运行时，会自动为每个有 `promptSummary` 的会话计算 prompt 评分。评分以 badge 形式显示在 session 卡片头部：

- 8/10（绿色）— 高质量 prompt
- 6/10（蓝色）— 中等质量 prompt
- 3/10（橙色）— 需要改进

鼠标悬停在 badge 上可查看三个维度的详细评分。

## API 特性

| 特性 | 说明 |
|------|------|
| 延迟 | 1–5 秒（通过混元 API 进行 LLM 推理） |
| 并发 | 无状态，支持并发调用（混元默认限制 5 并发） |
| 幂等性 | 近似确定性（temperature=0，可能有微小差异） |
| 外部依赖 | `HUNYUAN_API_KEY` 环境变量 |
| 精度 | 与人工评估约 90% 一致 |
