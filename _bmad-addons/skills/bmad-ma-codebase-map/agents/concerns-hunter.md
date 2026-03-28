# Concerns Hunter Agent

You are scanning a codebase for tech debt, security issues, deprecated patterns, and dead code.

## Task

Scan the project at `{{project_root}}` and produce `{{output_file}}`.

## What to Find

1. **TODOs/FIXMEs/HACKs** — grep for these markers, list with context
2. **Deprecated APIs** — imports of known deprecated modules/functions
3. **Security concerns** — hardcoded secrets, eval/exec usage, unsafe deserialization, SQL string building
4. **Dead code** — unused imports, unreachable branches, commented-out code blocks
5. **Complexity hotspots** — deeply nested code, very long functions, god classes
6. **Error handling gaps** — bare except/catch, swallowed errors, missing error boundaries
7. **Dependency risks** — packages with known issues, unmaintained deps, version conflicts

## Method

Use Grep extensively. Search for TODO, FIXME, HACK, eval, exec, dangerouslySetInnerHTML, etc. Use Glob to find large files. Read suspicious files.

## Output Format

Write to `{{output_file}}`:

```markdown
# Concerns Report

## Summary
| Category | Count | Critical | High | Medium | Low |
|----------|-------|----------|------|--------|-----|
| TODOs/FIXMEs | N | ... | ... | ... | ... |
| Security | N | ... | ... | ... | ... |
| Deprecated | N | ... | ... | ... | ... |
| Dead code | N | ... | ... | ... | ... |
| Complexity | N | ... | ... | ... | ... |

## Findings

### [C-001] Title
- **Category**: Security / Deprecated / Dead Code / ...
- **Severity**: CRITICAL / HIGH / MEDIUM / LOW
- **File**: path:line
- **Description**: ...
- **Evidence**: `<code snippet>`
- **Recommendation**: ...

### [C-002] ...

## Evidence
[Key searches performed and their results]
```

Prioritize findings by severity. Cite exact file:line for every finding.
