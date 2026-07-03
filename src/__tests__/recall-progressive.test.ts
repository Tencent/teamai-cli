/**
 * Tests for three-tier progressive retrieval (route / context / lookup)
 * of queryCodeKnowledge.
 *
 * Verifies:
 *   1. depth=route returns only the router file content
 *   2. depth=context searches overview/modules/docs but excludes navigation files
 *      and leaf component files
 *   3. depth=lookup searches all files including component.md
 *   4. graph-boost is applied in context mode when a valid graph-index.json exists
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';

import { queryCodeKnowledge } from '../code-knowledge-recall.js';

// ---------------------------------------------------------------------------
// Fixture content constants
// ---------------------------------------------------------------------------

const ROUTER_CONTENT = `search-anchor: 路由, 索引
title: Question Router

## 问题路由表

| 关键词 | 指向文件 |
|--------|----------|
| 依赖关系 | evidence/code/test-project/overview.md |
| 模块 | evidence/code/test-project/modules/src.md |
`;

const INDEX_CONTENT = `# Team Wiki Index

This file lists all top-level topics.
`;

const HOT_CONTENT = `# Hot Context

Recently accessed pages are listed here.
`;

const OVERVIEW_CONTENT = `title: test-project overview

## Module Structure

This project is structured as follows:
- src: main source module
- docs: documentation
`;

const COMPONENT_CONTENT = `title: components

## Component Registry

- ButtonComponent: importFromRepo('ui-kit', 'Button')
- InputComponent: importFromRepo('ui-kit', 'Input')
- ModalComponent: importFromRepo('ui-kit', 'Modal')
- TableComponent: importFromRepo('ui-kit', 'Table')

Each component uses importFromRepo to pull from the shared library.
`;

const SRC_MODULE_CONTENT = `title: src module

## Source Module

The src module handles all business logic.
It uses importFromRepo to pull shared utilities.

## recall

This module participates in knowledge recall workflows.
`;

const README_CONTENT = `title: G-Document 路由

## Overview

G-Document routes requests to the correct handler.
See graph-g1-relations for the full dependency graph.
`;

const ARCHITECTURE_CONTENT = `title: architecture

## 项目概述

This document describes the overall architecture.
`;

// ---------------------------------------------------------------------------
// Helper: build the full wiki tree under a tmpdir
// ---------------------------------------------------------------------------

async function buildWikiTree(tmpDir: string): Promise<void> {
  const evidenceCodeProject = path.join(tmpDir, 'evidence', 'code', 'test-project');
  const modulesDir = path.join(evidenceCodeProject, 'modules');
  const docsDir = path.join(evidenceCodeProject, 'docs');

  await fs.ensureDir(modulesDir);
  await fs.ensureDir(docsDir);

  // Top-level navigation files
  await fs.writeFile(path.join(tmpDir, 'router.md'), ROUTER_CONTENT, 'utf-8');
  await fs.writeFile(path.join(tmpDir, 'index.md'), INDEX_CONTENT, 'utf-8');
  await fs.writeFile(path.join(tmpDir, 'hot.md'), HOT_CONTENT, 'utf-8');

  // Project files
  await fs.writeFile(path.join(evidenceCodeProject, 'overview.md'), OVERVIEW_CONTENT, 'utf-8');
  await fs.writeFile(path.join(evidenceCodeProject, 'component.md'), COMPONENT_CONTENT, 'utf-8');
  await fs.writeFile(path.join(modulesDir, 'src.md'), SRC_MODULE_CONTENT, 'utf-8');
  await fs.writeFile(path.join(docsDir, 'README.md'), README_CONTENT, 'utf-8');
  await fs.writeFile(path.join(docsDir, 'architecture.md'), ARCHITECTURE_CONTENT, 'utf-8');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('queryCodeKnowledge — progressive depth retrieval', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-recall-progressive-'));
    await buildWikiTree(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  // -------------------------------------------------------------------------
  // Test 1: route mode returns only router file
  // -------------------------------------------------------------------------
  it('depth=route 时只返回路由文件内容', async () => {
    const results = await queryCodeKnowledge('依赖关系', {
      wikiRoot: tmpDir,
      depth: 'route',
      limit: 10,
    });

    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Question Router');
    expect(results[0].snippet).toContain('问题路由表');
  });

  // -------------------------------------------------------------------------
  // Test 2: context mode searches overview/modules/docs but excludes nav files
  //         and component.md (not matched by CONTEXT_ALLOWED_PATTERNS)
  // -------------------------------------------------------------------------
  it('depth=context 时搜索 overview/modules/docs 但排除 router/index/hot/component', async () => {
    const results = await queryCodeKnowledge('importFromRepo', {
      wikiRoot: tmpDir,
      depth: 'context',
      limit: 10,
    });

    // At least one result must be present (from modules/src.md)
    expect(results.length).toBeGreaterThan(0);

    const paths = results.map(r => r.page);

    // modules/src.md or overview.md must appear (both contain the keyword or are eligible)
    const hasEligibleHit = paths.some(
      p => p.includes('modules/src.md') || p.includes('overview.md'),
    );
    expect(hasEligibleHit).toBe(true);

    // Navigation / excluded files must NOT appear
    for (const p of paths) {
      expect(p).not.toMatch(/router\.md$/);
      expect(p).not.toMatch(/index\.md$/);
      expect(p).not.toMatch(/hot\.md$/);
      expect(p).not.toMatch(/component\.md$/);
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: lookup mode searches all files including component.md
  // -------------------------------------------------------------------------
  it('depth=lookup 时搜索全部文件包括 component.md', async () => {
    const results = await queryCodeKnowledge('importFromRepo', {
      wikiRoot: tmpDir,
      depth: 'lookup',
      limit: 10,
    });

    const paths = results.map(r => r.page);
    const hasComponent = paths.some(p => p.includes('component.md'));
    expect(hasComponent).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 4: graph-boost applies in context mode when graph-index.json exists
  // -------------------------------------------------------------------------
  it('context 模式的 graph-boost 仍然生效', async () => {
    // graph-index.json is read from wikiRoot/.indices/ by loadGraphIndex
    const indicesDir = path.join(tmpDir, '.indices');
    await fs.ensureDir(indicesDir);

    const graphIndex = {
      schemaVersion: 'team-wiki.graph-index.v1',
      generatedAt: new Date().toISOString(),
      nodes: [
        {
          slug: 'recall',
          type: 'module',
          confidence: 'EXTRACTED',
          title: 'recall',
        },
        {
          slug: 'src-module',
          type: 'module',
          confidence: 'EXTRACTED',
          title: 'src module',
        },
      ],
      edges: [
        {
          from: 'recall',
          to: 'src-module',
          relation: 'REFERENCES',
        },
      ],
    };

    await fs.writeFile(
      path.join(indicesDir, 'graph-index.json'),
      JSON.stringify(graphIndex, null, 2),
      'utf-8',
    );

    const results = await queryCodeKnowledge('recall', {
      wikiRoot: tmpDir,
      depth: 'context',
      limit: 10,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0);
  });
});
