// Test-runner adapter registry. Each adapter knows:
//   - which language it covers (file-extension fan-out for discovery),
//   - how to detect that the project actually uses it (manifest files,
//     config files, dotfiles),
//   - how to enumerate skipped tests by static-scanning sources for the
//     runner's skip syntax.
//
// We do NOT execute test runners here — that requires the project's deps
// to be installed and breaks on ecosystems we don't speak natively. Static
// scanning trades some false negatives (conditional skips that fire only
// at collection time) for total reliability and zero deps.
//
// Each enumerator returns:
//   [{ file, line, reason, marker }]
// where `reason` is the literal reason string when the runner records one,
// or an empty string when it doesn't (jest/vitest/cargo with no message).
// `marker` is the runner-specific skip primitive (e.g. `pytest.mark.skip`,
// `it.skip`, `t.Skip`, `#[ignore]`) for human-readable reporting.

const fs = require('node:fs');
const path = require('node:path');

function readSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function hasAny(rootDir, names) {
  return names.some((n) => fs.existsSync(path.join(rootDir, n)));
}

function packageJsonHas(rootDir, key) {
  const pkg = readSafe(path.join(rootDir, 'package.json'));
  if (!pkg) return false;
  try {
    const parsed = JSON.parse(pkg);
    if (parsed[key]) return true;
    return (
      Object.hasOwn(parsed.devDependencies || {}, key) ||
      Object.hasOwn(parsed.dependencies || {}, key)
    );
  } catch {
    return false;
  }
}

// =============================================================================
// pytest
// =============================================================================
//
// Skip syntaxes:
//   @pytest.mark.skip
//   @pytest.mark.skip(reason='...')
//   @pytest.mark.skipif(<expr>, reason='...')
//   pytest.skip('...')
//   unittest.skip('...')
//   unittest.skipIf(<expr>, '...')
//   unittest.skipUnless(<expr>, '...')

const pytestAdapter = {
  name: 'pytest',
  lang: 'python',
  detect(root) {
    // Bare pytest.ini or a conftest.py are sufficient signals on their own.
    // pyproject.toml needs the substring check because many Python projects
    // ship one without using pytest at all.
    if (fs.existsSync(path.join(root, 'pytest.ini'))) return true;
    if (fs.existsSync(path.join(root, 'conftest.py'))) return true;
    const setup = readSafe(path.join(root, 'setup.cfg'));
    if (setup && /\[tool:pytest\]|\[pytest\]/.test(setup)) return true;
    const tox = readSafe(path.join(root, 'tox.ini'));
    if (tox && /\[(?:tool:)?pytest\]/.test(tox)) return true;
    const py = readSafe(path.join(root, 'pyproject.toml'));
    if (py && /\bpytest\b/.test(py)) return true;
    return false;
  },
  enumerateSkips(files) {
    const skips = [];
    // Decorators can have nested parens (e.g. `@pytest.mark.skipif(not has_gpu(), reason=...)`)
    // so the simple `\(([^)]*)\)` capture doesn't work — it stops at the first `)`. Instead,
    // detect the marker on the line and pull `reason='...'` and string positionals from
    // anywhere on the same line. Reason kwarg wins over positional.
    const PYTEST_DECORATOR_HEAD = /@(?:pytest|_?pytest)\.mark\.(skip|skipif)\b/;
    const PYTEST_SKIP_CALL = /pytest\.skip\s*\(\s*['"]([^'"]+)['"]/;
    const UNITTEST_DECORATOR_HEAD = /@(?:unittest\.)?(skip|skipIf|skipUnless)\s*\(/;
    for (const file of files) {
      if (!file.endsWith('.py')) continue;
      const text = readSafe(file);
      if (!text) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const dec = line.match(PYTEST_DECORATOR_HEAD);
        if (dec) {
          const reason = extractKwarg(line, 'reason') || '';
          skips.push({
            file,
            line: i + 1,
            reason,
            marker: `pytest.mark.${dec[1]}`,
          });
          continue;
        }
        const inline = line.match(PYTEST_SKIP_CALL);
        if (inline) {
          skips.push({ file, line: i + 1, reason: inline[1], marker: 'pytest.skip' });
          continue;
        }
        const ut = line.match(UNITTEST_DECORATOR_HEAD);
        if (ut) {
          // unittest.skip(reason) — reason is positional 1.
          // unittest.skipIf(cond, reason) / skipUnless(cond, reason) — reason
          // is positional 2. Pulling the LAST string literal on the line
          // works for both shapes; fall back to a kwarg form if no positional.
          const reason = extractLastStringArg(line) || extractKwarg(line, 'reason') || '';
          skips.push({ file, line: i + 1, reason, marker: `unittest.${ut[1]}` });
        }
      }
    }
    return skips;
  },
};

// Extract `key=...` kwarg value (string) from a Python argument list slice.
function extractKwarg(args, key) {
  const re = new RegExp(`${key}\\s*=\\s*(?:['"])([^'"]+)(?:['"])`);
  const m = args.match(re);
  return m ? m[1] : null;
}

function extractFirstStringArg(args) {
  const m = args.match(/^\s*['"]([^'"]+)['"]/);
  return m ? m[1] : null;
}

// Last quoted string literal on a line — heuristic for unittest.skipIf where
// the reason follows the condition argument. Uses matchAll to avoid pulling
// in any state-mutating regex APIs.
function extractLastStringArg(line) {
  const matches = Array.from(String(line).matchAll(/['"]([^'"]+)['"]/g));
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1];
}

// =============================================================================
// jest
// =============================================================================
//
// Skip syntaxes:
//   describe.skip(...), it.skip(...), test.skip(...)
//   xit(...), xdescribe(...), xtest(...)
//   it.todo(...), test.todo(...)  ← also surfaces in vitest
//
// Jest doesn't record a "reason" — the test name is the only string we have.
// We use that as the reason field so classification can still match keywords.

const JS_SKIP_PATTERNS = [
  // describe.skip('test', ...) | it.skip('test', ...) | test.skip('test', ...)
  { re: /\b(describe|it|test)\.skip\s*\(\s*['"`]([^'"`]+)['"`]/, marker: '$1.skip' },
  // xit('test', ...) | xdescribe('test', ...) | xtest('test', ...)
  { re: /\b(xit|xdescribe|xtest)\s*\(\s*['"`]([^'"`]+)['"`]/, marker: '$1' },
  // it.todo('name') | test.todo('name')
  { re: /\b(it|test)\.todo\s*\(\s*['"`]([^'"`]+)['"`]/, marker: '$1.todo' },
];

function jsSkipScan(files, runner) {
  const skips = [];
  for (const file of files) {
    if (!/\.(js|jsx|ts|tsx)$/i.test(file)) continue;
    const text = readSafe(file);
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const pat of JS_SKIP_PATTERNS) {
        const m = lines[i].match(pat.re);
        if (m) {
          // Substitute $1 placeholder in marker template.
          const marker = pat.marker.replace('$1', m[1]);
          skips.push({
            file,
            line: i + 1,
            reason: m[2] || '',
            marker: `${runner}:${marker}`,
          });
          break; // one match per line is enough
        }
      }
    }
  }
  return skips;
}

const jestAdapter = {
  name: 'jest',
  lang: 'js-ts',
  detect(root) {
    if (packageJsonHas(root, 'jest')) return true;
    return hasAny(root, ['jest.config.js', 'jest.config.ts', 'jest.config.cjs', 'jest.config.mjs']);
  },
  enumerateSkips(files) {
    return jsSkipScan(files, 'jest');
  },
};

// =============================================================================
// vitest
// =============================================================================

const vitestAdapter = {
  name: 'vitest',
  lang: 'js-ts',
  detect(root) {
    if (packageJsonHas(root, 'vitest')) return true;
    return hasAny(root, [
      'vitest.config.js',
      'vitest.config.ts',
      'vitest.config.mjs',
      'vitest.workspace.ts',
    ]);
  },
  enumerateSkips(files) {
    return jsSkipScan(files, 'vitest');
  },
};

// =============================================================================
// go test
// =============================================================================
//
// Skip syntaxes:
//   t.Skip(...) / t.Skipf(...)
//   b.Skip(...) / b.Skipf(...)   (benchmarks)
//   testing.Skip()               (rare; from imported test helpers)

const GO_SKIP = /\b([tb])\.Skip(?:f)?\s*\(\s*(?:"([^"]*)"|`([^`]*)`)?/;

const goTestAdapter = {
  name: 'go-test',
  lang: 'go',
  detect(root) {
    return fs.existsSync(path.join(root, 'go.mod'));
  },
  enumerateSkips(files) {
    const skips = [];
    for (const file of files) {
      if (!file.endsWith('_test.go')) continue;
      const text = readSafe(file);
      if (!text) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(GO_SKIP);
        if (m) {
          skips.push({
            file,
            line: i + 1,
            reason: m[2] || m[3] || '',
            marker: `${m[1]}.Skip`,
          });
        }
      }
    }
    return skips;
  },
};

// =============================================================================
// cargo test
// =============================================================================
//
// Skip syntaxes:
//   #[ignore]              (no reason)
//   #[ignore = "..."]      (with reason)
//   #[cfg(not(test))]      → not a skip; test simply not compiled in test mode

const RUST_IGNORE = /^\s*#\[\s*ignore(?:\s*=\s*"([^"]*)")?\s*\]/;

const cargoTestAdapter = {
  name: 'cargo-test',
  lang: 'rust',
  detect(root) {
    return fs.existsSync(path.join(root, 'Cargo.toml'));
  },
  enumerateSkips(files) {
    const skips = [];
    for (const file of files) {
      if (!file.endsWith('.rs')) continue;
      const text = readSafe(file);
      if (!text) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(RUST_IGNORE);
        if (m) {
          skips.push({
            file,
            line: i + 1,
            reason: m[1] || '',
            marker: '#[ignore]',
          });
        }
      }
    }
    return skips;
  },
};

// =============================================================================
// rspec
// =============================================================================
//
// Skip syntaxes:
//   pending '...' / pending
//   skip '...'    / skip
//   it '...', skip: '...'        (metadata-style)
//   it '...', pending: '...'

const RSPEC_PENDING_OR_SKIP = /^\s*(pending|skip)\b\s*(?:['"]([^'"]+)['"])?/;
const RSPEC_METADATA = /\bit\b[^,]+,\s*(?:skip|pending)\s*:\s*['"]([^'"]+)['"]/;

const rspecAdapter = {
  name: 'rspec',
  lang: 'ruby',
  detect(root) {
    if (fs.existsSync(path.join(root, '.rspec'))) return true;
    const gemfile = readSafe(path.join(root, 'Gemfile'));
    if (gemfile && /['"]rspec(?:-rails)?['"]/.test(gemfile)) return true;
    return false;
  },
  enumerateSkips(files) {
    const skips = [];
    for (const file of files) {
      if (!file.endsWith('_spec.rb')) continue;
      const text = readSafe(file);
      if (!text) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const ps = lines[i].match(RSPEC_PENDING_OR_SKIP);
        if (ps) {
          skips.push({
            file,
            line: i + 1,
            reason: ps[2] || '',
            marker: ps[1],
          });
          continue;
        }
        const meta = lines[i].match(RSPEC_METADATA);
        if (meta) {
          skips.push({
            file,
            line: i + 1,
            reason: meta[1] || '',
            marker: 'it metadata',
          });
        }
      }
    }
    return skips;
  },
};

// =============================================================================

const ADAPTERS = [
  pytestAdapter,
  jestAdapter,
  vitestAdapter,
  goTestAdapter,
  cargoTestAdapter,
  rspecAdapter,
];

function adapterByName(name) {
  return ADAPTERS.find((a) => a.name === name) || null;
}

module.exports = {
  ADAPTERS,
  adapterByName,
  pytestAdapter,
  jestAdapter,
  vitestAdapter,
  goTestAdapter,
  cargoTestAdapter,
  rspecAdapter,
  // Exposed for tests that want to drive the JS scanner directly.
  jsSkipScan,
  extractKwarg,
  extractFirstStringArg,
};
