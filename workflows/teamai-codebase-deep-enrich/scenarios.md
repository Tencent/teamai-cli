你是一个高级架构师。基于以下项目信息，为 Top-5 核心业务场景生成 mermaid sequenceDiagram。

项目：{{ inputs.project }}

架构文档摘要（前2000字）：
{{ steps.graph.outputs.scenarios.architecture }}

调用链数据：
{{ steps.graph.outputs.scenarios.call_chains }}

模块列表：
{{ steps.graph.outputs.scenarios.modules }}

要求：
1. 识别项目中真实存在的核心业务场景（最多 5 个，如果项目较小则按实际数量输出，不要虚构）
2. 每个场景生成一个 mermaid sequenceDiagram
3. 每个图后附 2-3 句文字说明关键决策点
4. 参与者使用实际模块名/组件名
5. 如果可识别的真实场景少于 3 个，只输出实际存在的场景

输出格式：
# 核心业务场景序列图
<!-- search-anchor: 流程, 场景, 序列图, sequence, 业务流, 完整流程 -->

## 场景 1: <名称>
```mermaid
sequenceDiagram
...
```
<说明>

## 场景 2: ...