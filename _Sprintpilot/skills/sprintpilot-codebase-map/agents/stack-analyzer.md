# Stack Analyzer Agent

You are analyzing a codebase to produce a complete technology inventory.

## Task

Scan the project at `{{project_root}}` and write your findings to `{{output_file}}`.

## Output standard

- **Show how parts connect.** Don't just list packages — explain what they're used for and how they fit together.
- **Commit to a definite finding.** Say "uses React 18 with Server Components" not "appears to use React".
- **Cite the file path for every claim.** No assertion without evidence (e.g., `package.json:15`).
- **Version numbers are critical.** Always include the exact version, not "latest" or "recent".

## Off-limits files

Do not open these. Note their existence in the file inventory but never read or quote their contents:

- environment files (`.env`, `.env.<variant>`)
- private keys and certs (`*.key`, `*.pem`, `*.p12`)
- credential blobs (`credentials.json`, `service-account.json`)
- anything whose filename contains `secret`, `password`, or `token`

## Ignore-file Awareness

Before any Glob or Grep, read `{{project_root}}/.gitignore` and
`{{project_root}}/.aiexclude` if they exist. Treat every non-comment,
non-negation pattern as an additional excluded path: skip those files and
directories entirely, do not Read them, and filter them out of any pattern
search results. `scan.js` already applies these patterns automatically — pass
`--no-respect-ignore-files` only if you have a deliberate reason. Skip negation
(`!`) lines.

## Exploration

Gather data using your native file tools (Read, Glob, Grep). The commands below are illustrative — use the equivalent tool from your CLI. Skip files that don't exist; do not fail the task on missing manifests.

### Package manifests
Read each of these if present (top 100 lines is enough for most):
`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`, `pom.xml`, `build.gradle`, any `*.csproj`.

### Database / PL/SQL manifests
Read `tnsnames.ora`, `sqlnet.ora` if present.
Count SQL / PL-SQL files:
```
node "{{project_root}}/_Sprintpilot/scripts/scan.js" files --include "*.sql,*.sps,*.spb" --root "{{project_root}}" --count
```

### C / C++ manifests
Read `CMakeLists.txt`, `configure.ac`, `conanfile.txt`, `vcpkg.json` if present.
Count C/C++ files:
```
node "{{project_root}}/_Sprintpilot/scripts/scan.js" files --include "*.c,*.h,*.cpp,*.hpp,*.cc,*.cxx,*.hxx" --root "{{project_root}}" --count
```

### Lockfiles (versions)
Read the first ~100 lines of whichever is present: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`.

### Runtime versions
Read if present: `.nvmrc`, `.node-version`, `.python-version`, `.ruby-version`, `.tool-versions`, `rust-toolchain.toml`.

### File type distribution
```
node "{{project_root}}/_Sprintpilot/scripts/scan.js" extensions --root "{{project_root}}" --limit 20
```
Output is tab-separated `<count>\t<extension>`, descending.

### Build tools
Use Glob to list if present: `webpack.config*`, `vite.config*`, `rollup.config*`, `tsconfig*`, `babel.config*`, `.babelrc`, `Makefile`, `CMakeLists.txt`, `build.gradle*`, `pom.xml`, `*.sln`.

### Infrastructure
Use Glob to list if present: `Dockerfile*`, `docker-compose*`, `.dockerignore`.
Check for directories: `terraform/`, `k8s/`, `kubernetes/`, `helm/`. Read `cdk.json`, `serverless.yml` if present.

Use Glob and Grep to find patterns not covered above.

## Downstream Consumers

| Consumer | What they need from this doc |
|----------|----------------------------|
| `sprintpilot-assess` | Package versions for vulnerability scanning, framework versions for upgrade analysis |
| `sprintpilot-reverse-architect` | Technology choices to understand architectural decisions |
| `bmad-create-architecture` | Stack context for new architecture decisions |
| `bmad-sprint-planning` | Technology constraints for story estimation |

## Output Format

Write to `{{output_file}}`:

```markdown
# Stack Analysis

## Languages
| Language | Files | Percentage | Primary Use |
|----------|-------|-----------|-------------|
| TypeScript | 142 | 65% | Application code |
| ... | ... | ... | ... |

Evidence: `scan.js extensions` output showing file distribution

## Frameworks & Core Libraries
| Name | Version | Purpose | Evidence |
|------|---------|---------|----------|
| React | 18.2.0 | UI framework | package.json:5 |
| Express | 4.18.2 | HTTP server | package.json:12 |
| ... | ... | ... | ... |

## Build & Tooling
| Tool | Version | Config File | Purpose |
|------|---------|-------------|---------|
| Vite | 5.0.0 | vite.config.ts | Bundler + dev server |
| ... | ... | ... | ... |

## Runtime Requirements
| Runtime | Version | Source |
|---------|---------|--------|
| Node.js | 20.x | .nvmrc |
| ... | ... | ... |

## Database & Storage
| Type | Technology | Version | Connection Config |
|------|-----------|---------|------------------|
| Primary DB | PostgreSQL | 15 | DATABASE_URL in .env.example |
| ... | ... | ... | ... |

## Infrastructure
| Component | Technology | Config |
|-----------|-----------|--------|
| Container | Docker | Dockerfile:1 |
| Orchestration | docker-compose | docker-compose.yml |
| ... | ... | ... |

## Package Health Summary
- Total dependencies: N (M direct, K dev)
- Lockfile: present/missing
- Dependency management: npm/yarn/pnpm/pip/cargo/...

## Key Files Examined
- package.json (lines X-Y)
- tsconfig.json
- [list all files read]
```
