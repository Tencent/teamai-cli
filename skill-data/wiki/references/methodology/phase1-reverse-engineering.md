# Phase 1: Architecture Reverse-Engineering, From Code to Architectural Understanding

## 1. Bottom-Up Layering Method

```
Step 1: Identify "leaf nodes" that operate directly on infrastructure
  ├── Database operations (MySQL/PostgreSQL/Redis/MongoDB)
  ├── Message queue operations (RabbitMQ/Kafka/RocketMQ)
  ├── External system calls (third-party APIs / low-level drivers)
  └── File/object storage operations (S3/OSS/COS)

Step 2: Identify "intermediate nodes" that orchestrate and route
  ├── Message routing frameworks (consumer routing and dispatch)
  ├── Task schedulers (cron jobs / delayed tasks)
  ├── Workflow orchestration engines (Workflow/Saga/state machines)
  └── Resource schedulers (load balancing / resource allocation)

Step 3: Identify "root nodes", the external entry points
  ├── API gateway / HTTP Handler / gRPC Server
  ├── Scheduled task entry points (Cron/Scheduler)
  └── Event listener entry points (Webhook/EventBus)

Step 4: Layer by call direction
  External entry → workflow orchestration → service execution → resource scheduling → data operations → infrastructure
```

### Layer Assignment Rules

| Distinguishing feature | Layer | Typical code pattern |
|---------|---------|-------------|
| HTTP/gRPC Server startup | API access layer | `http.ListenAndServe()`, `grpc.NewServer()` |
| Parameter validation + auth + rate limiting | API access layer | `validate()`, `auth()`, `rateLimit()` |
| Workflow step configs and state machines | Workflow engine layer | `workflow_config`, `state_machine` |
| MQ consumption + Handler routing | Service execution layer | `channel.consume()`, `handler.dispatch()` |
| Scheduling algorithms (Filter/Score) | Resource scheduling layer | `filter()`, `score()`, `schedule()` |
| DB CRUD + cache operations | Data adapter layer | `db.query()`, `redis.get()` |
| Low-level system calls/drivers | Base execution layer | `exec()`, `syscall.*`, `driver.*` |

## 2. Three-Layer Penetration Tracing (Core Methodology)

For every user-visible API operation, complete a three-layer penetration trace:

```
Layer 1: API entry layer
  ├── Locate the Handler function
  ├── Extract parameter validation logic
  ├── Identify hard-coded defaults and whitelists
  └── Determine the downstream call style (synchronous RPC / asynchronous MQ)

Layer 2: Workflow orchestration layer
  ├── Find the workflow config (workflow_config / saga_config)
  ├── Parse the step sequence (step name / execution module / rollback module / timeout / retry)
  ├── Annotate the execution module and rollback module of each step
  └── Determine how data is passed between steps

Layer 3: Service execution layer
  ├── Trace the concrete Handler implementation of each step
  ├── Identify database operations and state changes
  ├── Annotate external system calls
  └── Determine the callback path of the final execution result

Output: complete call chain sequence diagram + state transition diagram + data flow diagram
```

### Standard Format for Documenting Call Chains

```
[API name](code entry: {repo}/{path}/{file})
  → parameter validation + auth and rate limiting
  → [pre-checks]: {check content}
  → RPC/MQ → [orchestration layer] ({config file}: {operation name})
    → [service layer] ({config file}: {flow_name})
      → [{step 1 module}] {step 1 command} ({details})
      → [{step 2 module}] {step 2 command} ({details})
      → ...
      → callback to [orchestration layer]
```

## 3. Component Relationship Matrix

Build an N×N relationship matrix annotated with the communication style:

| Caller ↓ / Callee → | ComponentA | ComponentB | ComponentC |
|---------------------|-------|-------|-------|
| **ComponentA** | — | RPC | MQ |
| **ComponentB** | — | — | DB |
| **ComponentC** | RPC | MQ | — |

Legend: `RPC` (synchronous) / `MQ` (asynchronous) / `DB` (shared database) / `—` (no direct communication)
