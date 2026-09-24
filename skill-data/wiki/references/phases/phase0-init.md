## Phase 0: Initialisation

Ask the user for all of the following in one go (**a single message, not step by step**):

1. **Paths of all code repositories of the project** (the user lists every repository the project involves):
   - Format: one absolute path per line, or comma-separated
   - Example:
     ```
     /path/to/api-gateway
     /path/to/order-service
     /path/to/user-service
     /path/to/common-lib
     ```
   - Note: this is the most critical step. The code of a large project is spread across many repositories, and **all of them** must be provided to build complete architecture awareness. A missing repository = a blind spot in the knowledge base.
2. **Project name** (used in document names, e.g. "CVM", "E-commerce Platform")
3. **Product documentation sources** (optional; when provided, the Type-5/6 bridge documents are generated):
   - API documentation directory path
   - Usage limits / FAQ document path
4. **Output path** (default: `knowledge/` under the parent directory of the first repository)

**Step 0A: Repository inventory**

After receiving the user's repository list, build the repository inventory:

```
FOR each path provided by the user:
  1. Verify the path exists and is accessible
  2. Detect whether it is a git repository (has a .git directory)
  3. Detect the primary language (by file extension distribution)
  4. Measure code size (file count + estimated line count)
  5. Record the git commit SHA + tag

Write the result to _review/repo-manifest.json:
{
  "repos": [
    {
      "path": "/absolute/path/to/repo-a",
      "name": "repo-a",
      "language": "go",
      "files": 320,
      "lines_estimate": 45000,
      "commit": "abc123",
      "tag": "v1.2.0",
      "accessible": true
    },
    ...
  ],
  "total_repos": N,
  "inaccessible": ["path/to/repo-x (permission denied)"]
}
```

Show it to the user for confirmation:
```
Identified {N} repositories:
  ✅ repo-a (Go, ~45K lines)
  ✅ repo-b (Python, ~12K lines)
  ✅ repo-c (Go, ~28K lines)
  ❌ repo-x (path does not exist or is not accessible)

Total: ~{N}K lines of code, {N} repositories
Reply "continue" if this is correct, or add the missing repositories.
```

**Step 0B: Auto-detect the primary language** (aggregated over the repository list, does not block the flow):
```
Detection method: aggregate the file extension distribution of all repositories
  .go files dominate              → language: "go"
  .py files dominate              → language: "python"
  .java files dominate            → language: "java"
  .ts/.js files dominate          → language: "typescript"
  .rs files dominate              → language: "rust"
  Mixed languages (no clear majority) → language: "mixed"
Note: the language field selects the grep patterns for the interface scan (see Phase K1 Step 5)
```

**Step 0C: Record the baseline version**:
```bash
# Record each repository separately
FOR repo in repos:
  git -C <repo.path> rev-parse HEAD 2>/dev/null
  git -C <repo.path> describe --tags --always 2>/dev/null
```
Write to `_review/metadata.json`:
```json
{
  "project_name": "CVM",
  "scan_time": "<ISO8601>",
  "repos": [
    {"name": "repo-a", "commit": "<sha>", "tag": "<tag>"},
    {"name": "repo-b", "commit": "<sha>", "tag": "<tag>"}
  ]
}
```

**Step 0D: CLI structural baseline (per code repository, recommended)**

Before the K1 deep read, use TeamAI to extract evidence-backed import/call structural edges (Python/Go/TS etc., `code-ast`) and merge them with the regex baseline (`code-heuristic`):

```bash
# For each repo. Writes <repo>/teamwiki/ (evidence pages + .indices/graph-index.json).
# Existing flags only: --extract [path], optional --project <slug>, optional --incremental.
teamai codebase --extract <repo_abs_path> --project <project_slug>
```

- Output: `teamwiki/evidence/code/<project>/` pages; `teamwiki/.indices/graph-index.json` (structural edges).
- When K1/K2/K3 write `edges[]` in `_manifest.json`: **prefer citing** the `code-ast` edges from extract + their `evidenceRefs` (`path:line`); label Agent inferences `INFERRED`/`AMBIGUOUS`.
- After Phase K3, skip any extra graph compile / merge step that is not a `teamai` command. TeamAI does not ship a separate team-wiki CLI. Continue with this skill using `teamai` and the files under this skill directory. No extra plugin is required.

Write the initial progress.json (current_phase: "phase0_done") and enter **Phase K1**.

---
