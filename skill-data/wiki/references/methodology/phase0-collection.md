# Phase 0: Source Material Collection and Preprocessing

## Repository Discovery and Classification

Starting from the entry repository, recursively discover all related repositories:

1. **Dependency analysis**: parse project dependency files (such as `requirements.txt`, `package.json`, `pom.xml`, `Cargo.toml`, `go.mod`, chosen by the detected language)
2. **Configuration references**: parse module names referenced in workflow orchestration configs → repository mapping
3. **RPC service discovery**: extract service names from service registry configs → repository mapping
4. **Classify by architecture layer**: API access layer / workflow engine layer / service execution layer / resource scheduling layer / data adapter layer / base execution layer
5. **Mark core-ness**: compute priority from lines of code, number of dependents, and Handler count

## Key File Extraction Checklist

| File type | Match pattern | Extraction purpose |
|---------|---------|---------|
| **Entry files** | `main.py`, `main.go`, `cmd/*/main.go`, `app.ts` | Service startup and initialization flow |
| **Routes/Handlers** | `handler.*`, `router.*`, `controller.*` | API endpoints and message handling entry points |
| **Config files** | `*config*.*`, `conf/`, `*.yaml`, `*.toml` | Workflow orchestration, parameter configuration |
| **Proto/IDL** | `*.proto`, `*.thrift`, `*schema*` | RPC interface contracts and data structures |
| **Database operations** | `*db*.*`, `*dao*.*`, `*model*.*`, `*repository*.*` | Data models and table schemas |
| **Constants/error codes** | `*const*`, `*error*`, `*code*`, `*enum*` | Error code system and business constants |
| **Test files** | `*_test.*`, `test_*.*` | Expected behavior and edge conditions |

## Building the Code Knowledge Graph

Before generating documents, build a code knowledge graph as an intermediate representation:

**Node types**: `[Service]` / `[Handler]` / `[Config]` / `[Table]` / `[Queue]` / `[API]` / `[ErrorCode]`

**Edge types**: `[CALLS]` (synchronous RPC/HTTP) / `[PUBLISHES]` (asynchronous MQ) / `[CONSUMES]` (MQ consumption) / `[READS]` (DB read) / `[WRITES]` (DB write) / `[CONFIGURES]` (config-driven) / `[MAPS_TO]` (product → code)

**Construction methods** (ordered by availability):
1. **`teamai codebase --extract`**: Tree-sitter structural edges (**TS/JS/Python/Go** and more) + multi-language heuristic fact pages (writes `teamwiki/`)
2. Grep + Read (Agent K1/K2): supplement dynamic routes and config-driven calls
3. Parse orchestration configs → module → command mapping
4. Parse Proto/IDL/DDL → data structures and table relationships (structured files, can be parsed precisely)
5. MQ topology inference → Exchange/Topic/Queue/Routing Key
6. API mapping → external API name → internal Handler entry point

> `code-ast` can produce `DEPENDS_ON` edges for relative imports; package-level and dynamic calls may still be missed, mark them `[UNVERIFIED]` or `AMBIGUOUS`.
> AST results take precedence over heuristics. There is no separate capabilities doc in this package; use `teamai codebase --extract` output under `teamwiki/`.

## Input Source Priority

| Priority | Input source | Specific content | Output document types |
|--------|--------|---------|------------|
| **P0 required** | Code repositories | Directory structure, entry files, configs, Proto | Type-1,4 |
| **P0 required** | Workflow orchestration configs | workflow_config / state machines | Type-1,4,5 |
| **P0 required** | Product API docs | Interface parameters, error codes | Type-5,6 |
| **P1 important** | Database schema | DDL, table schemas | Type-4 |
| **P1 important** | Product usage docs | Usage limits, FAQ | Type-6,8a |
| **P2 enhancement** | Git history | Commit/MR records | Type-8b |
| **P2 enhancement** | Incident records | Incident reports | Type-8d |
