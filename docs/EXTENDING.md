# Extending the Add-On

> **Windows note:** All addon scripts (`scripts/*.sh`, `install.sh`, `uninstall.sh`) run under **Git Bash**, which ships with [Git for Windows](https://git-scm.com/download/win). The launcher explicitly prefers Git Bash over WSL bash, so Windows-style paths (`C:\...`) work transparently. When extending the addon on Windows, edit the `.sh` files in Git Bash (or any editor with LF line endings) and use forward slashes inside scripts.

## Adding a New Git Platform

The addon supports GitHub, GitLab, Bitbucket, and Gitea. To add another platform:

### 1. Add to `modules/git/platform.yaml`

```yaml
  myplatform:
    detect_cli: "mycli --version"              # Command to check if CLI is installed
    detect_remote: "myplatform\\.com[:/]"      # Regex to match git remote URL
    pr_create: |
      mycli pr create --base {base_branch} --head {branch} --title "{title}" --body "$(cat <<'__BMAD_MY_EOF__'
      {body}
      __BMAD_MY_EOF__
      )"
    pr_merge: "mycli pr merge {pr_id}"
    pr_list: "mycli pr list --format json"
    pr_term: "PR"                               # or "MR" for merge request terminology
    # Optional API fallback when CLI unavailable:
    api_fallback:
      pr_create: |
        curl -s -X POST "{base_url}/api/pulls" \
          -H "Authorization: token $MYPLATFORM_TOKEN" \
          -d '{"base":"{base_branch}","head":"{branch}","title":"{title}","body":"{body}"}'
```

### 2. Add to `scripts/detect-platform.sh`

Add CLI detection:
```bash
HAS_MYCLI=false
mycli --version &>/dev/null && HAS_MYCLI=true
```

Add to the counter:
```bash
[ "$HAS_MYCLI" = true ] && DETECTED=$((DETECTED + 1)) && SINGLE="myplatform"
```

Add URL regex match:
```bash
if echo "$REMOTE_URL" | grep -qE 'myplatform\.com[:/]'; then
  echo "myplatform"
  exit 0
fi
```

### 3. Add to `scripts/create-pr.sh`

Add a case block:
```bash
  myplatform)
    if command -v mycli &>/dev/null; then
      PR_URL=$(mycli pr create ...) || { echo "ERROR: ..." >&2; exit 1; }
      echo "$PR_URL"
    elif [ -n "$MYPLATFORM_TOKEN" ]; then
      # API fallback
      ...
    else
      echo "SKIPPED"; exit 2
    fi
    ;;
```

### 4. Update config

Add the provider option to `modules/git/config.yaml`:
```yaml
platform:
  provider: auto # auto | github | gitlab | bitbucket | gitea | myplatform | git_only
```

### Current Platforms

| Platform | CLI | Detect Remote | API Fallback | Token Env Var |
|----------|-----|---------------|-------------|---------------|
| GitHub | `gh` | `github.com` | No (gh required) | — |
| GitLab | `glab` | `gitlab.` | No (glab required) | — |
| Bitbucket | `bb` | `bitbucket.org` | Yes (REST API) | `BITBUCKET_TOKEN` |
| Gitea | `tea` | None (self-hosted) | Yes (REST API) | `GITEA_TOKEN` |

---

## Adding a New Linter / Language

The addon auto-detects project languages and runs the appropriate linter on changed files only.

### 1. Add to `modules/git/config.yaml`

Under `lint.linters`, add your language:
```yaml
    linters:
      mylang: [linter1, linter2]    # First found wins
```

### 2. Add to `scripts/lint-changed.sh`

Add a detection + run block inside the `detect_and_lint()` function:

```bash
  # MyLang
  MYLANG_FILES=$(echo "$files" | grep -E '\.myext$' || true)
  if [ -n "$MYLANG_FILES" ]; then
    if command -v linter1 &>/dev/null; then
      combined_output="${combined_output}$(run_linter "linter1" "linter1 check" "$MYLANG_FILES")\n"
      found_any=true
    elif command -v linter2 &>/dev/null; then
      combined_output="${combined_output}$(run_linter "linter2" "linter2 --format text" "$MYLANG_FILES")\n"
      found_any=true
    fi
  fi
```

**Pattern:** Match file extensions → check if linter is installed → run on matched files.

For linters that don't take individual files (like `dotnet format` or `cargo clippy`), pass empty string for files and the linter runs on the whole project:

```bash
  combined_output="${combined_output}$(run_linter "dotnet-format" "dotnet format --verify-no-changes" "")\n"
```

### Currently Supported Languages

| Language | Extensions | Linters (first found wins) | Install (macOS / Linux) | Install (Windows) |
|----------|-----------|---------------------------|-------------------------|-------------------|
| Python | `.py` | ruff, flake8, pylint | `pip install ruff` | `pip install ruff` |
| JavaScript | `.js`, `.jsx` | eslint, biome | `npm install eslint` | `npm install eslint` |
| TypeScript | `.ts`, `.tsx` | eslint, biome | `npm install eslint` | `npm install eslint` |
| Rust | `.rs` | cargo clippy | Included with Rust | Included with Rust |
| Go | `.go` | golangci-lint | `brew install golangci-lint` | `winget install golangci-lint` or `scoop install golangci-lint` |
| Ruby | `.rb` | rubocop | `gem install rubocop` | `gem install rubocop` |
| Java | `.java` | checkstyle, pmd | `brew install checkstyle` | `scoop install checkstyle` or download JAR |
| C | `.c`, `.h` | cppcheck, clang-tidy | `brew install cppcheck` | `winget install cppcheck` or `choco install cppcheck` |
| C++ | `.cpp`, `.cc`, `.cxx`, `.hpp` | cppcheck, clang-tidy | `brew install cppcheck` | `winget install cppcheck` or `choco install cppcheck` |
| C# | `.cs` | dotnet format | Included with .NET SDK | Included with .NET SDK |
| Swift | `.swift` | swiftlint | `brew install swiftlint` | Not officially supported on Windows |
| PL/SQL | `.sql`, `.pls`, `.plb`, `.pks`, `.pkb` | sqlfluff | `pip install sqlfluff` | `pip install sqlfluff` |
| Kotlin | `.kt` | ktlint, detekt | `brew install ktlint` | `scoop install ktlint` or `choco install ktlint` |
| PHP | `.php` | phpstan, phpcs | `composer require --dev phpstan/phpstan squizlabs/php_codesniffer` | `composer require --dev phpstan/phpstan squizlabs/php_codesniffer` |

> On Windows, ensure each linter is on the **Git Bash** PATH (not just CMD/PowerShell). Most installers above add to system PATH, which Git Bash inherits — verify with `which <linter>` inside a Git Bash shell.

### Notes on Specific Languages

**Java**: `checkstyle` uses Google's style by default (`/google_checks.xml`). For custom rules, create a `checkstyle.xml` in your project root and the linter will pick it up.

**C/C++**: `cppcheck` works standalone. `clang-tidy` may require a `compile_commands.json` — generate it with `cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON`.

**C#**: `dotnet format` runs on the whole solution/project, not individual files. It requires a `.sln` or `.csproj` file.

**PL/SQL**: `sqlfluff` defaults to the Oracle dialect. Change `--dialect` in the script for PostgreSQL (`postgres`), MySQL (`mysql`), T-SQL (`tsql`), etc.

**Swift**: `swiftlint` uses `.swiftlint.yml` in the project root if present.

### Multi-Language Projects (Monorepos)

The linter script runs ALL applicable linters. In a monorepo with Python + TypeScript:
1. Python files → ruff (or flake8/pylint)
2. TypeScript files → eslint (or biome)

Both run in the same invocation. Output is combined, errors prioritized over warnings.
