// -*- coding: utf-8 -*-
import fs from 'fs-extra';
import { parse as parseYaml } from 'yaml';

import { RepoListFileSchema, type RepoListFile } from './schema.js';

/**
 * 加载并校验 repo-list yaml 文件。
 *
 * @param filePath yaml 文件路径
 * @returns        校验通过的 RepoListFile 对象
 * @throws         文件不存在时抛 Error('Repo list not found: <path>')
 * @throws         yaml 解析或 schema 校验失败时抛对应错误
 */
export async function loadRepoList(filePath: string): Promise<RepoListFile> {
    const exists = await fs.pathExists(filePath);
    if (!exists) {
        throw new Error(`Repo list not found: ${filePath}`);
    }

    const raw = await fs.readFile(filePath, 'utf8');
    const parsed: unknown = parseYaml(raw);
    const result = RepoListFileSchema.parse(parsed);
    return result;
}
