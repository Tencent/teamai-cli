# CI 代码侵蚀检测（informational）

> [English](ci-code-erosion.md) | [简体中文](ci-code-erosion.zh-CN.md)

`Code Erosion` 工作流（`.github/workflows/code-erosion.yml`）会在每个 PR 上报告两项
「代码 slop（邋遢度）」指标，使用官方
[`scb-check`](https://pypi.org/project/scb-check/) 工具（SlopCodeBench 的权威实现，
出自 [Measuring the sloppiness of code](https://earendil.com/posts/measuring-code-sloppiness/)）。

它是 **informational——只报告，绝不阻塞合入。** 数值以 PR 评论形式发出（并同步写到
运行的 job summary），供 reviewer 参考,不做任何门禁。

---

## 测什么

| 指标 | 含义 |
|---|---|
| **Verbosity（冗余度）** | 冗余源码行占比：`\|重复行 ∪ wrapper 行 ∪ ast-grep 规则命中行\| / SLOC`。 |
| **Erosion（侵蚀度）** | 复杂度向已经很复杂的函数集中的程度：`mass(f) = CC(f) × √SLOC(f)`；圈复杂度 `> 10` 的函数占总 mass 的比例。 |
| **Cognitive erosion（认知侵蚀）** | 与 erosion 同公式，但用认知复杂度而非圈复杂度加权。`scb-check` 额外提供的信号。 |

原文给出的参考区间（基于 **Python** 仓库校准）：

| 指标 | 人类仓库 | Agent 生成 |
|---|---|---|
| Verbosity | 0.15 ± 0.06 | 0.33 ± 0.10 |
| Erosion | 0.31 ± 0.17 | 0.68 ± 0.20 |

---

## 本 TypeScript 仓库的重要说明

`scb-check` 的 verbosity 由三部分组成：重复代码检测、trivial wrapper，以及
**197 条手写 ast-grep 规则**。这 197 条规则是 **Python 专属的**——它们编码的是
Python 特有的啰嗦写法（dict 惯用法、推导式、`for i in range(len(...))` 等），
在 TypeScript 里没有对应语法。在本仓库它们贡献 **0**。

因此数值要这样读：

- **`erosion` / `cognitive erosion` 是忠实的。** 圈复杂度与认知复杂度都是语言无关的，
  TypeScript 实现与 Python 用的是同一套算法。
- **`verbosity` 是不完整的。** 它只反映重复代码 + wrapper 检测。原文指出重复代码占
  agent slop 增长的约 66%、ast-grep 规则仅约 15.6%，所以这个数仍抓住了主要部分——但它
  **不能**直接与论文的 verbosity 数值或 Python 校准的区间对比。参考区间只当**方向**看，
  别当结论。

---

## 当前基线

扫描 `src/`（已排除测试，见 `scb-check.toml`），`scb-check==0.2.0`：

| 指标 | 数值 | 读法 |
|---|---|---|
| Verbosity | ~0.092 | 低于人类区间 |
| Erosion | ~0.65 | 落在 agent 区间 |
| Cognitive erosion | ~0.86 | — |

Erosion 落在 agent 区间，主要是因为少数几个超大函数（如 `pullForScope`、`init`、
`pushCore`）。如果团队将来想把这个数降下来，这几个函数就是最有行动价值的着手点。

---

## 细节

- **触发：** 任何指向 `master` / `main` 的 PR。
- **工具版本：** pin 在 `scb-check==0.2.0`——第一个支持 TypeScript 的版本。论文 pin 的
  `0.1.3` 只支持 Python。pin 版本也能让数值跨运行可比（规则集会随版本变化）。
- **范围：** `src/`，排除 `**/__tests__/**` 和 `*.test.ts` / `*.spec.ts`
  （在 `scb-check.toml` 中配置），让指标反映产品代码而非远大得多的测试套件。
- **绝不阻塞：** `scb-check` 一旦发现任何 slop 就返回非零退出码（这是常态）。工作流
  刻意吞掉这个退出码，job 永远是绿的。
- **fork PR：** 发 PR 评论需要写权限，fork PR 拿不到。此时优雅降级到 job summary——
  不会失败。

## 本地运行

```bash
uvx --from 'scb-check==0.2.0' scb-check check src \
  --report --include-all --config scb-check.toml
```

想要可读的控制台表格就加 `--output-format human`，或去掉 `--report` 用默认的
human 输出。

## TS verbosity 规则层

因为 scb-check 的 ast-grep 规则在 TypeScript 上永远不跑（见上文局限），我们额外跑一层
**独立的** `ast-grep`，用手工移植的规则集 `.github/ast-grep-rules/ts-verbosity.yml`，
报告里会多出一张 `Rule hits (TS verbosity layer)` 表。

诚实边界：这**不是**还原了论文的 verbosity 数值，而是一个额外、独立的信号。
SlopCodeBench 的 197 条 Python 规则里约一半是 Python 语法专属（dict 惯用法、推导式、
`typing`），在 TypeScript 里根本不存在；剩下的里只移植了**纯结构性**的规则——涉及
真值/类型语义的都试过并**刻意弃用**，因为它们在 TypeScript 里是假阳性：

- `len(x) == 0` → TS 的 `arr.length > 0` 是地道写法，不是 slop。
- `x == True` → TS 的 `x !== true` 处理 `boolean | undefined`，与 `x === false`
  **不等价**（TS 有 `undefined`，Python 没有）。
- 模板串检查大多误伤多行字符串拼接。

已移植的（全部纯结构性，且在 `src/` 上验过无假阳性）：
`unnecessary-else-after-return`、`empty-catch-block`、`redundant-ternary-same`、
`if-return-boolean-literal`、`return-ternary-boolean-literal`、
`duplicated-if-condition`、`self-assignment`。规则用 `severity: hint`，扫描永不卡关。
本地运行：

```bash
npx -p @ast-grep/cli@0.45.3 ast-grep scan \
  -r .github/ast-grep-rules/ts-verbosity.yml --json=stream src
```

## 去哪看结果

1. **PR 评论**——每个 PR 一条评论，每次 push 就地更新。
2. **Job summary**——工作流运行的 summary 页上同一张表（fork PR 上唯一的呈现处）。
