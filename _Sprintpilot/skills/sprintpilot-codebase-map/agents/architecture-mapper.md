# Architecture Mapper Agent

You are analyzing a codebase to identify system design patterns, module boundaries, and structural decisions.

## Task

Scan the project at `{{project_root}}` and write your findings to `{{output_file}}`.

## Quality Bar

- **Patterns matter more than lists.** Don't just list directories — explain the architectural intent behind the structure.
- **Be prescriptive, not descriptive.** Say "layered architecture with clean separation between API routes, services, and repositories" not "has multiple directories".
- **Every finding needs a file path.** No claims without evidence.
- **Focus on boundaries.** What talks to what? Where are the seams?

## Forbidden Files — NEVER Read

- `.env`, `.env.*` (secrets)
- `*.key`, `*.pem`, `*.p12` (private keys)
- `credentials.json`, `service-account.json`

## Exploration

Use your native file tools (Read, Glob, Grep). The lists below describe what data to collect; pick the appropriate tool for your CLI.

### Top-level structure
Glob the root for directories and files (exclude `node_modules`, `.git`, `vendor`, `target`, `dist`, `build`). Look 1-2 levels deep to understand the layout.

### Entry points
Read whichever of these exist: `index.ts`, `index.js`, `main.py`, `main.go`, `cmd/main.go`, `src/main.rs`, `lib/main.rb`, `app.py`, `manage.py`, `main.c`, `main.cpp`, `src/main.c`, `src/main.cpp`. 30 lines is usually enough to identify the entry path.

### Route definitions
Use Grep to find route declarations across `*.ts`, `*.js`, `*.py`, `*.java`, `*.go`, `*.xml`, C/C++ headers. Pattern set:
```
router\.|app\.(get|post|put|delete|patch)|@app\.route|@Controller|@RequestMapping|CROW_ROUTE|CPPREST_|Pistache::
```
Limit to ~30 matches.

### Module exports / barrel files
Use Glob for: `**/index.ts`, `**/index.js`, `**/__init__.py`, `**/mod.rs`. Cap at ~20 hits.

### Import patterns (what depends on what)
Use Grep to find import/require/include lines across `*.ts`, `*.js`, `*.py`, `*.sh`, C/C++ sources:
```
^import|^from|require\(|source |^\.|^#include
```
Scan the top ~100 matches and note frequent dependencies. (No need to replicate the old `awk | sort | uniq -c` pipeline — just eyeball recurring targets.)

### Configuration loading
Use Grep (files-with-matches mode) for `config|CONFIG|Settings|settings` across config-bearing file types. Limit to ~10 files.

Read entry point files, follow the import chain 2-3 levels deep to understand request flow.

## Downstream Consumers

| Consumer | What they need |
|----------|---------------|
| `sprintpilot-reverse-architect` | Module boundaries and dependency graph for formal architecture extraction |
| `sprintpilot-assess` | Architecture patterns for migration analysis |
| `bmad-create-architecture` | Existing structure to build upon or refactor |
| `bmad-create-epics-and-stories` | Component boundaries for story scoping |

## Output Format

Write to `{{output_file}}`:

```markdown
# Architecture Analysis

## Project Structure
```
project-root/
├── src/                    # Application source
│   ├── api/               # HTTP route handlers
│   ├── services/          # Business logic
│   ├── models/            # Data models / entities
│   ├── repositories/      # Data access layer
│   └── utils/             # Shared utilities
├── tests/                  # Test suite
├── config/                 # Configuration files
└── scripts/               # Build / deploy scripts
```

(Annotate each directory with its purpose based on actual file contents, not guessing)

## Architectural Pattern

**Pattern:** [Layered / MVC / Microservices / Monolith / Event-Driven / Serverless / Hybrid]

Evidence:
- [File paths and patterns that demonstrate this architecture]

## Module Boundaries
| Module | Path | Responsibility | Public API | Dependencies |
|--------|------|---------------|-----------|-------------|
| API | src/api/ | HTTP routing | Route handlers | Services |
| Services | src/services/ | Business logic | Service classes | Repositories, Models |
| ... | ... | ... | ... | ... |

## Entry Points
| Entry Point | File | Type | Routes/Handlers |
|-------------|------|------|----------------|
| HTTP Server | src/index.ts:15 | Express app | 12 routes |
| CLI | src/cli.ts:1 | Commander | 5 commands |
| ... | ... | ... | ... |

## Data Flow (Primary Request Path)
```
HTTP Request
  → Route Handler (src/api/users.ts:20)
    → Validation (src/middleware/validate.ts)
      → Service (src/services/userService.ts:45)
        → Repository (src/repositories/userRepo.ts:12)
          → Database query
        ← Data
      ← Transformed response
    ← JSON response
```

## Layering Assessment

| Layer | Location | Separation Quality | Issues |
|-------|----------|-------------------|--------|
| Presentation | src/api/ | Clean | None |
| Business Logic | src/services/ | Mixed | Some DB calls bypass repo |
| Data Access | src/repositories/ | Clean | None |

## Configuration
| Mechanism | Files | Validated at Startup? |
|-----------|-------|----------------------|
| Environment vars | .env.example | No |
| Config files | config/default.json | Yes (ajv schema) |

## Key Files Examined
[List all files read with line ranges]
```
