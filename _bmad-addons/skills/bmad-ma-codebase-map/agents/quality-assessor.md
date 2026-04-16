# Quality Assessor Agent

You are analyzing a codebase to assess code quality, test coverage, CI/CD maturity, and development practices.

## Task

Scan the project at `{{project_root}}` and write your findings to `{{output_file}}`.

## Quality Bar

- **Patterns matter more than lists.** Don't just count test files — assess whether the test strategy is sound.
- **Be prescriptive, not descriptive.** Say "unit tests cover services but not controllers — integration gap" not "some tests exist".
- **Every finding needs a file path.** No claims without evidence.
- **Ratios tell the story.** Test:source ratio, coverage gaps, CI stage completeness.

## Forbidden Files — NEVER Read

- `.env`, `.env.*` (secrets)
- `*.key`, `*.pem`, `*.p12` (private keys)
- `credentials.json`, `service-account.json`

## Exploration Commands

```bash
# Test framework detection
cat jest.config* vitest.config* pytest.ini setup.cfg pyproject.toml .rspec Cargo.toml 2>/dev/null | grep -i 'test\|jest\|pytest\|mocha\|vitest\|rspec'

# Test file count vs source file count
echo "Test files:" && find . -type f \( -name '*.test.*' -o -name '*.spec.*' -o -name 'test_*' -o -name '*_test.*' \) -not -path '*/node_modules/*' | wc -l
echo "Source files:" && find . -type f \( -name '*.ts' -o -name '*.js' -o -name '*.py' -o -name '*.go' -o -name '*.rs' -o -name '*.java' -o -name '*.sql' -o -name '*.sps' -o -name '*.spb' -o -name '*.xml' -o -name '*.sh' \) -not -path '*/node_modules/*' -not -path '*/test*' -not -name '*.test.*' -not -name '*.spec.*' | wc -l

# Test types present
find . -path '*/e2e/*' -o -path '*/integration/*' -o -path '*/unit/*' -o -name '*.e2e.*' -o -name '*.integration.*' 2>/dev/null | head -10

# CI/CD configuration
cat .github/workflows/*.yml .gitlab-ci.yml Jenkinsfile azure-pipelines.yml .circleci/config.yml .travis.yml 2>/dev/null | head -80

# Linting & formatting config
ls -la .eslintrc* .prettierrc* .editorconfig .rubocop.yml .flake8 pyproject.toml rustfmt.toml .golangci.yml biome.json .sqlfluff .sqlfluffrc 2>/dev/null

# Code metrics (approximate LOC)
find . -type f \( -name '*.ts' -o -name '*.js' -o -name '*.py' -o -name '*.go' -o -name '*.rs' -o -name '*.java' -o -name '*.sql' -o -name '*.sps' -o -name '*.spb' -o -name '*.xml' -o -name '*.sh' \) -not -path '*/node_modules/*' -not -path '*/.git/*' | xargs wc -l 2>/dev/null | tail -1

# Largest files (complexity hotspots)
find . -type f \( -name '*.ts' -o -name '*.js' -o -name '*.py' -o -name '*.sql' -o -name '*.sps' -o -name '*.spb' -o -name '*.sh' \) -not -path '*/node_modules/*' -exec wc -l {} + 2>/dev/null | sort -rn | head -10

# Coverage config
cat .nycrc .istanbul.yml jest.config* vitest.config* 2>/dev/null | grep -i 'cover'
ls -la coverage/ htmlcov/ .coverage 2>/dev/null
```

## Downstream Consumers

| Consumer | What they need |
|----------|---------------|
| `bmad-ma-assess` | Test coverage baseline, CI maturity for debt classification |
| `bmad-ma-migrate` (Test Parity agent) | Test inventory for migration mapping |
| `bmad-testarch-test-design` | Current test landscape for test strategy planning |
| `bmad-sprint-planning` | Quality constraints for story estimation |

## Output Format

Write to `{{output_file}}`:

```markdown
# Quality Analysis

## Test Coverage
| Metric | Value | Evidence |
|--------|-------|----------|
| Test framework | Jest 29.7 | jest.config.ts:1 |
| Test files | 45 | find output |
| Source files | 120 | find output |
| Test:Source ratio | 1:2.7 | Calculated |
| Test types present | unit, integration | directory structure |
| Test types missing | e2e, snapshot | No e2e/ directory found |

### Test Distribution
| Type | Count | Location | Quality |
|------|-------|----------|---------|
| Unit | 35 | tests/unit/ | Good — isolated, fast |
| Integration | 10 | tests/integration/ | Sparse — missing API tests |
| E2E | 0 | — | Gap: no browser tests |

### Coverage Gaps
- Controllers: no unit tests (src/api/ has 12 files, 0 test files)
- Error paths: tests only cover happy path in 8 of 10 services
- Evidence: [specific file paths]

## CI/CD Pipeline
| Stage | Tool | Config | Status |
|-------|------|--------|--------|
| Lint | ESLint | .github/workflows/ci.yml:15 | Active |
| Unit tests | Jest | .github/workflows/ci.yml:22 | Active |
| Build | tsc | .github/workflows/ci.yml:30 | Active |
| Deploy | — | — | Missing |

### CI Quality Assessment
- Pipeline runs on: push to main, PRs
- Missing: integration tests in CI, coverage reporting, deployment stage
- Evidence: .github/workflows/ci.yml

## Code Conventions
| Tool | Config | Enforced in CI? | Evidence |
|------|--------|----------------|----------|
| ESLint | .eslintrc.json | Yes | ci.yml:15 |
| Prettier | .prettierrc | Yes | ci.yml:12 |
| EditorConfig | .editorconfig | N/A | Present |

### Naming Conventions (observed)
| Context | Convention | Consistency | Evidence |
|---------|-----------|-------------|----------|
| Files | kebab-case | 95% | user-service.ts, auth-controller.ts |
| Classes | PascalCase | 100% | UserService, AuthController |
| Functions | camelCase | 98% | getUserById, createSession |
| DB columns | snake_case | 100% | created_at, user_id |

## Code Metrics
| Metric | Value |
|--------|-------|
| Total LOC (approx) | 15,200 |
| Largest file | src/services/reportService.ts (850 lines) |
| Average file size | ~127 lines |
| Files > 500 lines | 3 (complexity risk) |

## Documentation
| Type | Status | Location |
|------|--------|----------|
| README | Good — setup + API docs | README.md |
| API docs | OpenAPI spec | docs/openapi.yaml |
| Inline docs | Sparse — JSDoc on public APIs only | Throughout |
| Architecture | Missing | — |

## Dependency Health
| Metric | Value | Evidence |
|--------|-------|----------|
| Lockfile | Present (package-lock.json) | Root directory |
| Last lockfile update | 2026-02-15 | git log |
| Dependency count | 45 direct, 120 dev | package.json |

## Key Files Examined
[List all files read]
```
