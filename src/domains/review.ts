import chalk from 'chalk';
import { askQuestion, askConfirmation } from '../utils/prompt.js';
import type { DomainsFile, DomainEntry, HistoryEvent } from './schema.js';

/** reviewDomains 的返回结果。 */
export interface ReviewResult {
    result: DomainsFile;
    finalize: 'save' | 'draft' | 'abort';
}

/**
 * 深拷贝一个 DomainsFile。
 */
function deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj)) as T;
}

/**
 * 打印当前 domains 概要，用颜色区分置信度。
 */
function printSummary(domains: DomainEntry[], threshold: number): void {
    console.log('\n' + chalk.bold('=== 业务域概要 ==='));
    if (domains.length === 0) {
        console.log(chalk.gray('（暂无业务域）'));
        return;
    }
    domains.forEach((d, idx) => {
        const conf = d.confidence ?? 1;
        let nameStr: string;
        if (conf >= threshold) {
            nameStr = chalk.green(`[${idx}] ${d.name}`);
        } else if (conf >= threshold * 0.7) {
            nameStr = chalk.yellow(`[${idx}] ${d.name}`);
        } else {
            nameStr = chalk.red(`[${idx}] ${d.name}`);
        }
        console.log(`${nameStr} (${d.repos.length} 个仓库)`);
        d.repos.forEach((r, rIdx) => {
            const rConf = r.confidence ?? 1;
            let repoLine = `    [${rIdx}] ${r.url}`;
            if (r.locked) {
                repoLine += chalk.cyan(' [locked]');
            }
            if (rConf < threshold) {
                console.log(chalk.red(repoLine));
            } else if (rConf < 0.8) {
                console.log(chalk.yellow(repoLine));
            } else {
                console.log(repoLine);
            }
            if (r.signal) {
                console.log(chalk.gray(`       信号: ${r.signal}`));
            }
        });
    });
    console.log();
}

/**
 * 打印帮助菜单。
 */
function printHelp(): void {
    console.log(chalk.bold('\n可用指令:'));
    console.log('  a                    — 接受全部，直接保存');
    console.log('  r                    — 逐项 review 低置信仓库');
    console.log('  m <N> <M>            — 合并域 N 与 M（N 吸收 M）');
    console.log('  s <N>                — 拆分域 N');
    console.log('  e <N>                — 重命名域 N');
    console.log('  l <N> <M>            — 锁定域 N 中第 M 个仓');
    console.log('  x <N> <M> <newDomain>— 把域 N 的第 M 个仓重新分配到 newDomain');
    console.log('  h                    — 显示帮助');
    console.log('  q                    — 退出');
    console.log();
}

/**
 * 解析用户输入指令，返回指令名和参数数组。
 */
function parseCommand(input: string): { cmd: string; args: string[] } {
    const parts = input.trim().split(/\s+/);
    const cmd = (parts[0] ?? '').toLowerCase();
    const args = parts.slice(1);
    return { cmd, args };
}

/**
 * 进入交互式 review，最终把用户确认后的结果作为返回值（不写盘）。
 *
 * 支持操作：
 *   a — 接受全部
 *   r — 逐项 review 低置信仓库
 *   m N M — 合并域 N 与 M（N 吸收 M）
 *   s N — 拆分域 N
 *   e N — 重命名域 N
 *   l N M — 锁定域 N 中第 M 个仓（locked=true）
 *   x N M <newDomain> — 把域 N 的第 M 个仓重新分配到 newDomain
 *   q — 退出
 *
 * 非 TTY 环境下直接返回 draft 不变，finalize='draft'。
 *
 * @param draft 待 review 的草稿
 * @param opts.onEvent 每次有效操作的事件回调
 */
export async function reviewDomains(
    draft: DomainsFile,
    opts?: { onEvent?: (e: HistoryEvent) => void | Promise<void> }
): Promise<ReviewResult> {
    // 非 TTY 直接返回
    if (!process.stdin.isTTY) {
        return { result: draft, finalize: 'draft' };
    }

    const onEvent = opts?.onEvent;
    let current = deepClone(draft);
    const threshold = current.confidence_threshold;

    /** 触发事件回调 */
    async function emit(event: Omit<HistoryEvent, 'ts' | 'actor'>): Promise<void> {
        if (onEvent) {
            await onEvent({
                ts: new Date().toISOString(),
                actor: 'user',
                ...event,
            } as HistoryEvent);
        }
    }

    printHelp();

    // 主循环
    while (true) {
        printSummary(current.domains, threshold);

        let input: string;
        try {
            input = await askQuestion('review> ');
        } catch {
            // readline 关闭时退出
            return { result: current, finalize: 'draft' };
        }

        const { cmd, args } = parseCommand(input);

        if (cmd === 'h' || cmd === '?') {
            printHelp();
            continue;
        }

        if (cmd === 'a') {
            // 接受全部
            await emit({ action: 'accept', details: { count: current.domains.length } });
            return { result: current, finalize: 'save' };
        }

        if (cmd === 'q') {
            // 退出询问
            console.log('\n退出选项:');
            console.log('  1 — 保存为正式版本');
            console.log('  2 — 仅保留草稿');
            console.log('  3 — 放弃所有更改');
            let choice: string;
            try {
                choice = await askQuestion('请选择 (1/2/3): ');
            } catch {
                return { result: current, finalize: 'draft' };
            }
            if (choice.trim() === '1') {
                return { result: current, finalize: 'save' };
            } else if (choice.trim() === '3') {
                return { result: draft, finalize: 'abort' };
            } else {
                return { result: current, finalize: 'draft' };
            }
        }

        if (cmd === 'r') {
            // 逐项 review 低置信仓库
            const lowConfRepos: Array<{ domainIdx: number; repoIdx: number }> = [];
            current.domains.forEach((d, dIdx) => {
                d.repos.forEach((r, rIdx) => {
                    if ((r.confidence ?? 1) < threshold) {
                        lowConfRepos.push({ domainIdx: dIdx, repoIdx: rIdx });
                    }
                });
            });

            if (lowConfRepos.length === 0) {
                console.log(chalk.green('没有低置信度的仓库需要 review。'));
                continue;
            }

            console.log(`\n共 ${lowConfRepos.length} 个低置信度仓库需要 review：`);
            for (const { domainIdx, repoIdx } of lowConfRepos) {
                const domain = current.domains[domainIdx];
                const repo = domain?.repos[repoIdx];
                if (!domain || !repo) continue;
                console.log(chalk.yellow(`\n域: ${domain.name}[${domainIdx}] / 仓库[${repoIdx}]: ${repo.url}`));
                console.log(chalk.gray(`  信号: ${repo.signal ?? '无'}, 置信度: ${repo.confidence ?? '未知'}`));

                let action: string;
                try {
                    action = await askQuestion('操作 (k=保留/d=移到未分类/r=重新分配): ');
                } catch {
                    break;
                }

                if (action.trim() === 'd') {
                    // 移到未分类
                    domain.repos.splice(repoIdx, 1);
                    let unclassified = current.domains.find((d) => d.name === '未分类');
                    if (!unclassified) {
                        unclassified = { name: '未分类', description: '', repos: [] };
                        current.domains.push(unclassified);
                    }
                    unclassified.repos.push({ ...repo });
                    await emit({
                        action: 'reassign',
                        details: { url: repo.url, from: domain.name, to: '未分类' },
                    });
                } else if (action.trim().startsWith('r')) {
                    let newDomainName: string;
                    try {
                        newDomainName = await askQuestion('目标域名: ');
                    } catch {
                        break;
                    }
                    const target = current.domains.find((d) => d.name === newDomainName.trim());
                    if (!target) {
                        console.log(chalk.red(`域「${newDomainName.trim()}」不存在，跳过。`));
                        continue;
                    }
                    domain.repos.splice(repoIdx, 1);
                    target.repos.push({ ...repo });
                    await emit({
                        action: 'reassign',
                        details: { url: repo.url, from: domain.name, to: newDomainName.trim() },
                    });
                }
                // k 或其他 → 保留
            }
            continue;
        }

        if (cmd === 'm') {
            // 合并：m N M — N 吸收 M
            const nIdx = parseInt(args[0] ?? '', 10);
            const mIdx = parseInt(args[1] ?? '', 10);
            if (isNaN(nIdx) || isNaN(mIdx) || !current.domains[nIdx] || !current.domains[mIdx]) {
                console.log(chalk.red('用法: m <N> <M>，N 和 M 必须是有效的域索引。'));
                continue;
            }
            const target = current.domains[nIdx]!;
            const source = current.domains[mIdx]!;
            target.repos.push(...source.repos);
            current.domains.splice(mIdx, 1);
            await emit({ action: 'merge', details: { into: target.name, merged: source.name } });
            console.log(chalk.green(`已将「${source.name}」合并到「${target.name}」。`));
            continue;
        }

        if (cmd === 's') {
            // 拆分：s N
            const nIdx = parseInt(args[0] ?? '', 10);
            if (isNaN(nIdx) || !current.domains[nIdx]) {
                console.log(chalk.red('用法: s <N>，N 必须是有效的域索引。'));
                continue;
            }
            const domain = current.domains[nIdx]!;
            if (domain.repos.length < 2) {
                console.log(chalk.red(`域「${domain.name}」只有 ${domain.repos.length} 个仓库，无法拆分。`));
                continue;
            }
            // 显示仓库列表
            domain.repos.forEach((r, idx) => {
                console.log(`  [${idx}] ${r.url}`);
            });
            let indicesInput: string;
            try {
                indicesInput = await askQuestion('请输入要拆出的仓库索引（空格分隔）: ');
            } catch {
                continue;
            }
            const indices = indicesInput.trim().split(/\s+/)
                .map((s) => parseInt(s, 10))
                .filter((n) => !isNaN(n) && n >= 0 && n < domain.repos.length);
            if (indices.length === 0) {
                console.log(chalk.red('无有效索引，取消拆分。'));
                continue;
            }
            let newDomainName: string;
            try {
                newDomainName = await askQuestion('新域名: ');
            } catch {
                continue;
            }
            const splitRepos = indices.map((i) => domain.repos[i]!);
            // 从原域移除（倒序删除避免索引错位）
            [...indices].sort((a, b) => b - a).forEach((i) => {
                domain.repos.splice(i, 1);
            });
            current.domains.push({
                name: newDomainName.trim(),
                description: '',
                repos: splitRepos,
            });
            await emit({
                action: 'split',
                details: { from: domain.name, newDomain: newDomainName.trim(), repoCount: splitRepos.length },
            });
            console.log(chalk.green(`已从「${domain.name}」拆出 ${splitRepos.length} 个仓库到「${newDomainName.trim()}」。`));
            continue;
        }

        if (cmd === 'e') {
            // 重命名：e N
            const nIdx = parseInt(args[0] ?? '', 10);
            if (isNaN(nIdx) || !current.domains[nIdx]) {
                console.log(chalk.red('用法: e <N>，N 必须是有效的域索引。'));
                continue;
            }
            const domain = current.domains[nIdx]!;
            const oldName = domain.name;
            let newName: string;
            try {
                newName = await askQuestion(`新域名（当前: ${oldName}）: `);
            } catch {
                continue;
            }
            if (!newName.trim()) {
                console.log(chalk.red('域名不能为空。'));
                continue;
            }
            domain.name = newName.trim();
            await emit({ action: 'rename', details: { from: oldName, to: newName.trim() } });
            console.log(chalk.green(`已将域「${oldName}」重命名为「${newName.trim()}」。`));
            continue;
        }

        if (cmd === 'l') {
            // 锁定：l N M
            const nIdx = parseInt(args[0] ?? '', 10);
            const mIdx = parseInt(args[1] ?? '', 10);
            if (isNaN(nIdx) || isNaN(mIdx) || !current.domains[nIdx] || !current.domains[nIdx]!.repos[mIdx]) {
                console.log(chalk.red('用法: l <N> <M>，N 和 M 必须是有效的域/仓库索引。'));
                continue;
            }
            const repo = current.domains[nIdx]!.repos[mIdx]!;
            repo.locked = true;
            await emit({
                action: 'lock',
                details: { url: repo.url, domain: current.domains[nIdx]!.name },
            });
            console.log(chalk.cyan(`已锁定: ${repo.url}`));
            continue;
        }

        if (cmd === 'x') {
            // 重新分配：x N M <newDomain>
            const nIdx = parseInt(args[0] ?? '', 10);
            const mIdx = parseInt(args[1] ?? '', 10);
            const newDomainName = args.slice(2).join(' ').trim();
            if (
                isNaN(nIdx) || isNaN(mIdx) ||
                !current.domains[nIdx] || !current.domains[nIdx]!.repos[mIdx] ||
                !newDomainName
            ) {
                console.log(chalk.red('用法: x <N> <M> <newDomain>'));
                continue;
            }
            const sourceDomain = current.domains[nIdx]!;
            const repo = sourceDomain.repos[mIdx]!;
            const targetDomain = current.domains.find((d) => d.name === newDomainName);
            if (!targetDomain) {
                console.log(chalk.red(`域「${newDomainName}」不存在。`));
                continue;
            }
            sourceDomain.repos.splice(mIdx, 1);
            targetDomain.repos.push({ ...repo });
            await emit({
                action: 'reassign',
                details: { url: repo.url, from: sourceDomain.name, to: newDomainName },
            });
            console.log(chalk.green(`已将 ${repo.url} 从「${sourceDomain.name}」移到「${newDomainName}」。`));
            continue;
        }

        if (cmd !== '') {
            console.log(chalk.red(`未知指令「${cmd}」，输入 h 查看帮助。`));
        }
    }
}
