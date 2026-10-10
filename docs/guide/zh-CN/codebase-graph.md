# 代码知识图谱

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

`teamai import` 将源码仓库解析为结构化知识图谱（存储在团队仓库的 `teamwiki/` 目录下），实现结构感知的知识检索：

```bash
# 从本地目录提取
teamai import --dir /path/to/project

# 从远程仓库导入
teamai import --from-repo https://github.com/org/repo

# 批量导入组织下所有仓库
teamai import --from-org myorg

# 从白名单批量导入
teamai import --from-repo-list repos.yaml

# 从已合并的 MR/PR 提取经验
teamai import --from-mr https://github.com/org/repo/pull/123

# 增量模式（跳过未变更文件）
teamai import --from-repo https://github.com/org/repo --incremental

# 仅提取结构，跳过 AI 增强
teamai import --from-repo https://github.com/org/repo --skip-enrich
```

如果核心知识图谱提取或写入失败，导入会报错，且不会将该提交标记为已同步。下次增量导入会重试该提交。

使用 `--from-iwiki` 时，MCP 工具响应中的 `isError: true` 表示请求失败，即使响应包含文本。正文或元数据请求失败的页面会告警并在 AI 分类之前跳过；成功获取的页面仍会导入。页面树请求失败时会告警，并返回空的子页面列表。

加 `--dry-run` 时，`--from-repo` 与 `--from-repo-list` 用 `git ls-remote` 读取每个仓库的目标提交，打印 `Would import <owner>/<repo> at <commit>` 以及本地缓存是否最新，然后停止：

不会 clone 或 fetch 到缓存，不会获取导入锁，也不会运行任何 AI 步骤。使用 `--incremental` 且缓存含 `LAST_SYNC` 时，预览会查询该缓存配置的 origin 上当前分支的提交，与真实 fetch/reset 一致。完整克隆预览（包括缺少缓存或 `LAST_SYNC`）跟随远端 HEAD。若缓存分支已从远端删除，不执行 prune 的通配 fetch 会保留缓存 origin 引用，增量预览也使用该保留提交。启用 prune、显式 fetch 已删除分支或缺少缓存 origin 引用时，仍预览完整克隆回退。其他缓存分支查询失败时，预览会警告并预览完整克隆回退。 

指定 `--output` 时，预览会显示与真实导入相同的输出文件旁 `teamwiki/evidence/code/<slug>` 目标目录。

`--from-mr` 与 `teamai contribute` 的默认行为一样，把提取的经验发布到 `teamai-learnings` 分支：激活项目合计解析出恰好一个 learnings namespace 时放在 `learnings/<namespace>/` 下，否则放在共享的 `learnings/` 根目录。发布失败时，经验留在本机队列中，下次 `teamai pull` 会发布它；若阻止发布的是 teamai 拒绝使用的 learnings 检出，则在你按提示处理该检出之前，任何 pull 都无法发布它。

如果草稿与已有经验（共享根目录或当前激活项目的 namespace 中的）高度重叠，命令会列出这些文件（`Possible duplicate: this learning overlaps N existing learning(s): <files>.`），使用 `--all` 时同样如此。这只是提示：不会标记或替换任何已有经验。`manifest/projects.yaml` 无法读取时，只与共享根目录比较，并给出提示。

需要 AI 的步骤（`--deep-enrich`、知识增强）复用本机已安装的 AI 编码 CLI，而不是直接调用模型 API。teamai 按 `claude` → `claude-internal` → `codex` → `codex-internal` → `codebuddy` → `workbuddy` → `openclaw` 的顺序探测，取第一个可用者。macOS / Linux 上探测经由 login shell，因此装在 `~/.nvm/` 下的 CLI 也能找到；Windows 上改用原生命令 `where`，拿到的是 Windows 真正能启动的 npm shim（`%APPDATA%\npm\claude.cmd`）——Git Bash 或 WSL 的 `bash` 只会返回 `/c/Users/...` 这类 MSYS 路径，Windows 无法启动。

使用 `--from-org --dry-run` 时，CLI 展示本次过滤条件选中的仓库及白名单目标路径，不读取旧草稿、不写入白名单、不克隆仓库、不获取导入锁，也不运行 AI 增强。`--skip-import` 只预览白名单条目。CLI 原有的诊断日志记录仍会执行。

对于 GitHub，`--from-org` 先查询组织仓库列表；首次请求失败或返回空列表时，再查询用户仓库列表。若后者也失败，导入会报告错误并以非零状态退出，不再将失败当成空列表。`gh` 和直接使用 `GITHUB_TOKEN` / `GH_TOKEN` 的 API 路径均如此；成功返回空列表仍表示没有可导入的仓库。

对于 API 网关后的 GitLab，先设置 `GITLAB_URL` 和 `GITLAB_API_PREFIX=api/gitlab`，再运行 `teamai import --from-org https://gitlab.example.com/myorg`。组织仓库列表的每一页请求都会使用配置的前缀；未设置或为空时默认使用 `api/v4`。

图谱存储组件、接口、配置和跨仓库依赖关系。`teamai recall` 会将 learnings 与图谱 BM25 命中转换到有界的相关性分数尺度后合并排序。

依赖边由两条并行轨道提取：WASM tree-sitter **AST 轨**（TypeScript/JavaScript、Python、Go、Swift），将 import、调用、以及 TS `implements` 子句解析为精确的文件到文件边（`code-ast`）；以及正则 **启发式轨**（所有语言，`code-heuristic`），同时覆盖 AST 轨未支持的语言。重叠时 AST 结果优先。AST 解析器无需原生编译工具链；加载失败时提取会降级到启发式并记录一条 `AST_UNAVAILABLE` gap。设置 `TEAMAI_SKIP_AST=1` 可强制仅用启发式提取。

```bash
# 从本地仓库提取代码事实与图谱（写入 <repo>/teamwiki/）
teamai codebase --extract /path/to/repo --project my-service

# 增量刷新：复用首次提取的仓库路径和项目名
teamai codebase --extract /path/to/repo --project my-service --incremental

# 从已提取的 evidence 生成深度知识文档（--output 指向仓库根目录）
teamai codebase --deep-enrich --project my-service --output /path/to/repo

# 将 teamwiki/product 和 teamwiki/docs 与提取的代码页面进行对账
teamai codebase --reconcile --output /path/to/repo

# 检查本地提取的图谱；--output 指向仓库根目录，而非 teamwiki/
teamai codebase --lint --output /path/to/repo
```

只要 extract 发现了组件，就会写入 `teamwiki/evidence/code/<project>/_manifest.json`（包括跳过 AI 增强或增强没有产出的情况），因此 `--deep-enrich` 可以接着跑。

不传 `--project` 时，`<project>` 取目录名；在检出的根目录下（主检出或 git 链接 worktree）取仓库名：主检出的真实目录名（经符号链接打开时也是如此），或 bare 仓库的名称（`repo/.bare` 或 `repo.git` → `repo`）。同一仓库的所有检出写入同一个条目。`teamai import --dir` 用同样的方式确定 slug。

`.teamai/pending-review.jsonl` 中的待审改动可用 `teamai review` 查看。用 `teamai review <id> --apply --dry-run`、`teamai review <id> --reject --dry-run` 或 `teamai review --all-apply --max-risk medium --dry-run` 预览处理决定。应用预览会执行与真实应用相同的目标文件和托管章节校验，但不会修改文档或移除待审项；批量预览保留相同的类型与风险筛选。处理预览的 `--json` 输出包含 `dryRun: true`，其中 `ok` 表示通过校验，不表示已写入。去掉 `--dry-run` 才会执行处理。

**按 namespace 分发 wiki。** `recall` 对 `teamwiki/evidence/code/<slug>/` 采用与 docs 相同的作用域规则：只要有任一角色（`manifest/roles.yaml`）或项目（`manifest/projects.yaml`）在 `resources.wiki` 中列出某个 codebase slug，它就只分发给激活了它的成员；未声明的 slug 仍然共享：

```yaml
# manifest/projects.yaml
projects:
  - id: svc-a
    resources:
      wiki: [svc-a]     # 只有激活 svc-a 时才能看到 evidence/code/svc-a/
```

这个 slug 就是 `teamai codebase --project <slug>`（或 `teamai import`）写入 `evidence/code/` 时用的那个值，它与 manifest 的 project id 没有必然关系，按实际提取时用的那个值声明即可。旧式用法（没有角色、没有 `projects.yaml`）会搜索所有 codebase，和之前一样。
