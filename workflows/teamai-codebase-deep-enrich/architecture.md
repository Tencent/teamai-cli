<context>
项目: {{ inputs.project }}
模块清单:
{{ steps.plan.outputs.architecture.modules }}

模块间依赖:
{{ steps.plan.outputs.architecture.edges }}

接口统计:
{{ steps.plan.outputs.architecture.interfaces }}
</context>

为上述项目生成一份技术架构总览文档。必须包含：

## 项目概述
（一段话描述项目的核心定位和能力）

## 架构图
（ASCII 分层架构图，标注各模块和调用方向）

## 组件关系矩阵
（表格：组件A→组件B + 关系类型 + 通信方式）

## 核心链路
（2-3条最重要的请求处理链路，从入口到存储的完整路径）

## 技术栈
（表格：维度/技术/说明）

直接输出 Markdown，不要任何前言或解释。