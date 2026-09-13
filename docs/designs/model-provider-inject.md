# 模型 Provider 配置注入（`teamai model inject`）设计方案

> 目标：一条命令把本地已安装的 AI 工具指向某个 provider 的 OpenAI/Anthropic 兼容端点与模型列表。
> 参考实现：`dry-martine-harness/scripts/model`（provider 中立的 `*.model.json` → 各工具原生配置）。
> 范围：第一阶段 6 个工具；`openclaw`/`hermes`/`qoder`/`zcode` 为后续；Cursor 不支持。

## 1. 背景

团队各成员的 AI 工具需要统一指向团队约定的模型网关（如 deepseek）。目前 teamai 已能分发 skills/rules/hooks/mcp/env，但模型配置仍靠手工编辑各工具配置文件。本特性把“provider 中立定义 → 各工具原生模型配置”的渲染/合并/落盘固化为 CLI 能力。

## 2. 命令面

```bash
teamai model inject [--provider <id>] [--tool <name>]... [--endpoint anthropic|openai] [--dry-run]
teamai model list
```

- `--provider` 缺省为 `deepseek`。
- `--tool` 可重复或逗号分隔；省略时对所有“配置目录已存在”（即已安装）的受支持工具注入。
- provider 的 API Key 环境变量必须已设置，否则报错并列出变量名。
- 单个工具失败不影响其他工具；只要有失败，进程退出码非 0。

## 3. Provider 目录（内置 7 个）

`deepseek`（默认）、`glm`、`kimi`、`minimax`、`ollama`、`qwen`、`volcengine`。字段与参考实现一致：`provider`/`name`/`apiKey`(`${VAR}` 占位符)/`defaultEndpoint`/`endpoints.{anthropic,openai}.baseUrl`/`models.{fast,default,powerful}`（`contextWindow` 可选）。内置数据以 zod schema 校验，避免运行期出现半成品。

## 4. 工具目标（第一阶段）

| 工具 | 配置文件（env 覆盖） | 格式 | 端点 | Key 存储 |
|---|---|---|---|---|
| claude | `~/.claude/settings.json`（`CLAUDE_CONFIG_DIR`） | json | anthropic | 明文 |
| codex | `~/.codex/config.toml`（`CODEX_HOME`） | toml | openai | `env_key`（仅变量名） |
| opencode | `~/.config/opencode/opencode.json`（`XDG_CONFIG_HOME`） | json | openai | 明文 |
| dsh | `~/.dsh/settings.yaml`（`DSH_HOME`） | yaml | openai | `apiKeyEnv`（仅变量名） |
| codebuddy | `~/.codebuddy/models.json` | json | openai | 明文 |
| workbuddy | `~/.workbuddy/models.json` | json | openai | 明文 |

- “已安装”判定 = 配置文件所在目录存在。
- codex/dsh 的格式没有明文字段，只能写环境变量名；其余写解析后的明文（按用户决策）。
- claude 强制 anthropic 端点，codebuddy/workbuddy 强制 openai 端点（格式限制）。

## 5. 渲染

- **claude**：`env.ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`（tier + `[Nm]/[Nk]` 后缀），并带参考实现的 `CLAUDE_CODE_*` 默认值。
- **codex**：`model` / `model_provider` / `model_context_window?` / `model_providers.<id>{name,base_url,env_key,wire_api="responses"}`。
- **opencode**：`provider.<id>{npm,name,options{baseURL,apiKey},models{...}}` + `model="<id>/<default>"`。
- **dsh**：`llm-pi-ai.providers.<id>{apiKeyEnv,api,baseURL,models[]}` + `agent-default-model`。
- **codebuddy/workbuddy**：扁平 `models[]`（fast/default/powerful 去重），字段对齐 `local-agent.ts` 的 `buddyModelEntry`；`url` 以 `/chat/completions` 结尾；不写 `availableModels`（空=不限制）。

## 6. 合并与落盘

- 对象递归合并，标量覆盖。
- 带字符串 `id` 的对象数组按 id **upsert**（避免重复注入产生重复模型条目）；其余数组去重追加。
- 写入原子（临时文件 + rename），符号链接先解析到真实路径再写，保留 `.bak` 备份；新文件 `0600`。
- codebuddy/workbuddy 兼容对象包裹与旧版顶层数组两种根结构。

## 7. 非目标 / 已知限制

- **Cursor 不支持**：Cursor CLI 无 BYOK/自定义 provider 契约，仅用 Cursor 账号鉴权。
- **Codex** 仅支持 OpenAI Responses API；只提供 chat-completions 的 provider 需 Responses 兼容网关。
- YAML/TOML 序列化会丢失注释（`.bak` 保留原文件）。
- 模型配置不进入团队仓库，仅本地注入。

## 8. 文件改动

新增 `src/model/`：`providers.ts` / `merge.ts` / `config-file.ts` / `tool-targets.ts` / `service.ts`；命令 `src/model-cmd.ts`；接线 `src/index.ts`。
测试：`src/__tests__/model-config.test.ts`、`src/__tests__/model-cmd.test.ts`。
文档：`README(.zh-CN).md`、`docs/usage-guide(.zh-CN).md`、本文件。

## 9. 后续（第二阶段）

`openclaw`（`~/.openclaw/openclaw.json` 的 `models.providers` + `agents.defaults.model.primary`）、
`hermes`（`~/.hermes/config.yaml` 的 `model`）、
`qoder`（`~/.qoder/settings.json` 的 `modelConfigs.customModels`）、
`zcode`（`~/.zcode/cli/config.json` 的 `provider` + `model.main/lite`）。
