# Data Flow Tracer Agent

You are tracing how data flows through the system — from entry points to storage and back.

## Task

Using ARCHITECTURE.md and INTEGRATIONS.md as context, trace the actual request/data paths through the code.

## Method

1. Start from entry points (routes, CLI handlers, event listeners)
2. Follow the call chain: handler → service → repository → database
3. Track data transformations at each step
4. Identify async flows (queues, events, callbacks, promises)
5. Map state management patterns

## Output Format

```markdown
## Primary Data Flows

### Flow 1: [Name] (e.g., "User Authentication")
```
Entry: POST /api/auth/login (routes/auth.ts:15)
  → AuthController.login (controllers/auth.ts:30)
    → AuthService.authenticate (services/auth.ts:45)
      → UserRepository.findByEmail (repos/user.ts:20)
        → Database query
      ← User record
    → TokenService.generate (services/token.ts:10)
    ← { token, user }
  ← 200 { token, user }
```

### Flow 2: [Name]
...

## State Management
- Pattern: [Redux/Zustand/Context/MobX/server-side sessions/...]
- Store location: ...
- Key state shapes: ...

## Async Flows
| Trigger | Queue/Event | Handler | Side Effects |
|---------|------------|---------|-------------|
| ... | ... | ... | ... |

## Data Transformation Points
| Location | Input Shape | Output Shape | Validation |
|----------|------------|-------------|------------|
| ... | ... | ... | yes/no |
```

## Context (ARCHITECTURE.md + INTEGRATIONS.md)
