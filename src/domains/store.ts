import path from 'node:path';
import fs from 'fs-extra';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { DomainsFileSchema, HistoryEventSchema } from './schema.js';
import type { DomainsFile, HistoryEvent } from './schema.js';

const DOMAINS_PATH = '.teamai/domains.yaml';
const DRAFT_PATH = '.teamai/domains.draft.yaml';
const HISTORY_PATH = '.teamai/domains.history.jsonl';
/** 反序列化大小上限：10 MB，防止超大文件导致 OOM。 */
const MAX_CONFIG_FILE_BYTES = 10 * 1024 * 1024;

/**
 * 从 YAML 字符串解析并校验 DomainsFile，校验失败时抛出含字段信息的错误。
 */
function parseAndValidate(content: string, filePath: string): DomainsFile {
    const raw = yamlParse(content) as unknown;
    const result = DomainsFileSchema.safeParse(raw);
    if (!result.success) {
        const issues = result.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ');
        throw new Error(`Invalid domains file at ${filePath}: ${issues}`);
    }
    return result.data;
}

/**
 * 读取正式生效的 domains.yaml；不存在时返回带空 domains 数组的默认值。
 *
 * @param cwd 项目根目录
 */
export async function loadDomains(cwd: string): Promise<DomainsFile> {
    const filePath = path.join(cwd, DOMAINS_PATH);
    const exists = await fs.pathExists(filePath);
    if (!exists) {
        return DomainsFileSchema.parse({});
    }
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_CONFIG_FILE_BYTES) {
        throw new Error(`${filePath} exceeds max allowed size 10MB`);
    }
    const content = await fs.readFile(filePath, 'utf8');
    return parseAndValidate(content, filePath);
}

/**
 * 读取草稿 domains.draft.yaml；不存在返回 null。
 *
 * @param cwd 项目根目录
 */
export async function loadDomainsDraft(cwd: string): Promise<DomainsFile | null> {
    const filePath = path.join(cwd, DRAFT_PATH);
    const exists = await fs.pathExists(filePath);
    if (!exists) {
        return null;
    }
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_CONFIG_FILE_BYTES) {
        throw new Error(`${filePath} exceeds max allowed size 10MB`);
    }
    const content = await fs.readFile(filePath, 'utf8');
    return parseAndValidate(content, filePath);
}

/**
 * 把 DomainsFile 写到 .teamai/domains.yaml（正式）。
 *
 * @param cwd 项目根目录
 * @param data 要写入的数据
 */
export async function saveDomains(cwd: string, data: DomainsFile): Promise<void> {
    const filePath = path.join(cwd, DOMAINS_PATH);
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, yamlStringify(data), 'utf8');
}

/**
 * 把 DomainsFile 写到 .teamai/domains.draft.yaml（草稿）。
 *
 * @param cwd 项目根目录
 * @param data 要写入的数据
 */
export async function saveDomainsDraft(cwd: string, data: DomainsFile): Promise<void> {
    const filePath = path.join(cwd, DRAFT_PATH);
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, yamlStringify(data), 'utf8');
}

/**
 * 删除草稿文件。文件不存在不报错。
 *
 * @param cwd 项目根目录
 */
export async function clearDomainsDraft(cwd: string): Promise<void> {
    const filePath = path.join(cwd, DRAFT_PATH);
    const exists = await fs.pathExists(filePath);
    if (exists) {
        await fs.remove(filePath);
    }
}

/**
 * 追加一条历史事件到 domains.history.jsonl（每行一个 JSON 对象）。
 *
 * @param cwd 项目根目录
 * @param event 要追加的历史事件
 */
export async function appendHistory(cwd: string, event: HistoryEvent): Promise<void> {
    // 校验事件结构
    const validated = HistoryEventSchema.parse(event);
    const filePath = path.join(cwd, HISTORY_PATH);
    await fs.ensureDir(path.dirname(filePath));
    await fs.appendFile(filePath, JSON.stringify(validated) + '\n', 'utf8');
}
