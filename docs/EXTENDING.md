# Extending the Add-On

> **Windows note:** All addon scripts (`scripts/*.js`, `bin/sprintpilot.js install`, `bin/sprintpilot.js uninstall`) run under **Node.js 18+** with no Bash dependency. Any native `node.exe` (PATH, `nvm-windows`, Scoop, etc.) works; WSL and Git Bash are not required. Use forward slashes in paths — Node handles Windows path separators transparently.

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

### 2. Add to `scripts/detect-platform.js`

Both scripts are Node.js. Add a CLI probe entry to the platform list (each entry has a `cli` command and a `urlPattern` regex), then re-export the platform name from the priority resolver:

```js
const PLATFORMS = [
  // ...existing entries...
  {
    name: 'myplatform',
    cli: 'mycli --version',
    urlPattern: /myplatform\.com[:/]/i,
  },
];
```

Both the CLI probe (`spawnSync('mycli', ['--version'])`) and the URL regex are tried in priority order: explicit config > CLI detection > remote URL regex > `git_only` fallback.

### 3. Add to `scripts/create-pr.js`

Add a case for the new platform that delegates to the CLI primary path with an optional REST fallback. The pattern matches the existing Bitbucket/Gitea blocks:

```js
case 'myplatform': {
  if (hasCli('mycli')) {
    const result = spawnSync('mycli', ['pr', 'create',
      '--base', baseBranch, '--head', branch,
      '--title', title, '--body', body], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`mycli pr create failed: ${result.stderr}`);
    return result.stdout.trim(); // PR URL
  }
  if (process.env.MYPLATFORM_TOKEN) {
    // REST fallback via lib/runtime/http.js
    return await postJson(`${baseUrl}/api/pulls`, {
      headers: { Authorization: `token ${process.env.MYPLATFORM_TOKEN}` },
      body: { base: baseBranch, head: branch, title, body },
    });
  }
  return 'SKIPPED'; // git_only mode for this platform
}
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

### 2. Add to `scripts/lint-changed.js`

`lint-changed.js` is a Node.js script — language detection lives in a `LANGUAGES` table that pairs file-extension regexes with a list of linter probes. Add an entry:

```js
const LANGUAGES = [
  // ...existing entries...
  {
    name: 'mylang',
    extensions: /\.myext$/,
    linters: [
      { cmd: 'linter1', args: ['check'] },
      { cmd: 'linter2', args: ['--format', 'text'] },
    ],
  },
];
```

**Pattern:** match file extensions → probe each linter in priority order via `spawnSync('command', ['-v'])` → run the first one found on matched files.

For linters that don't take individual files (like `dotnet format` or `cargo clippy`), set `wholeProject: true` on the linter entry — the runner will invoke it without file arguments.

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
