#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const { tryRun } = require('../lib/runtime/spawn');
const { tryGitStdout } = require('../lib/runtime/git');
const { splitLines, countLines, headLines } = require('../lib/runtime/text');
const log = require('../lib/runtime/log');

function help() {
  log.out(
    'Usage: lint-changed.js [--limit 100] [--output-file path] [--linter <tool>] [--linters-json <json>]',
  );
}

// Normalize the user's linter-map config. The YAML has separate
// `javascript` and `typescript` keys; we classify both as `js-ts` for
// linting purposes (eslint / biome handle both). Aliases:
//   javascript|typescript → js-ts
// Each language's value must be an array of strings (linter names).
function normalizeLintersConfig(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const key of Object.keys(raw)) {
    const val = raw[key];
    if (!Array.isArray(val)) continue;
    const list = val.filter((x) => typeof x === 'string' && x.length > 0);
    const lang = key === 'javascript' || key === 'typescript' ? 'js-ts' : key;
    if (out[lang]) out[lang] = out[lang].concat(list);
    else out[lang] = list.slice();
  }
  // De-dupe each list (case where user set both javascript and typescript
  // and they share linters).
  for (const k of Object.keys(out)) {
    const seen = new Set();
    out[k] = out[k].filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
  }
  return out;
}

// Map a linter name (from config) to its (binPath, args) invocation.
// Returns null when the named linter isn't installed. Args are the
// preset flags for `<linter> [args] <files>` form.
async function resolveLinterByName(name, lang) {
  // For node-bin-style tools (eslint, biome), prefer node_modules/.bin
  // first so the project's pinned version wins over a global install.
  if (name === 'eslint' || name === 'biome') {
    const local = localBin(name);
    if (local) return { bin: local, args: name === 'biome' ? ['check'] : [] };
    if (await hasCli(name)) return { bin: name, args: name === 'biome' ? ['check'] : [] };
    return null;
  }
  if (name === 'ruff' && (await hasCli(name))) return { bin: name, args: ['check'] };
  if (name === 'flake8' && (await hasCli(name))) return { bin: name, args: [] };
  if (name === 'pylint' && (await hasCli(name))) return { bin: name, args: ['--output-format=text'] };
  if (name === 'cargo' || name === 'cargo-clippy' || name === 'clippy') {
    if (await hasCli('cargo')) return { bin: 'cargo', args: ['clippy', '--message-format=short'], noFiles: true };
    return null;
  }
  if (name === 'golangci-lint' && (await hasCli(name))) return { bin: name, args: ['run'], noFiles: true };
  if (name === 'rubocop' && (await hasCli(name))) return { bin: name, args: ['--format', 'simple'] };
  if (name === 'checkstyle' && (await hasCli(name))) {
    return { bin: name, args: fs.existsSync('checkstyle.xml') ? ['-c', 'checkstyle.xml'] : [] };
  }
  if (name === 'pmd' && (await hasCli(name))) return { bin: name, args: ['check', '-d'] };
  if (name === 'cppcheck' && (await hasCli(name))) {
    return {
      bin: name,
      args: lang === 'cpp' ? ['--enable=warning,style', '--language=c++'] : ['--enable=warning,style'],
    };
  }
  if (name === 'clang-tidy' && (await hasCli(name))) return { bin: name, args: [] };
  if ((name === 'dotnet' || name === 'dotnet format' || name === 'dotnet-format') && (await hasCli('dotnet'))) {
    return { bin: 'dotnet', args: ['format', '--verify-no-changes', '--diagnostics'], noFiles: true };
  }
  if (name === 'swiftlint' && (await hasCli(name))) return { bin: name, args: ['lint', '--quiet'] };
  if (name === 'sqlfluff' && (await hasCli(name))) return { bin: name, args: ['lint', '--dialect', 'oracle'] };
  if (name === 'ktlint' && (await hasCli(name))) return { bin: name, args: [] };
  if (name === 'detekt' && (await hasCli(name))) return { bin: name, args: ['--input'] };
  if (name === 'phpstan' && (await hasCli(name))) return { bin: name, args: ['analyse', '--no-progress'] };
  if (name === 'phpcs' && (await hasCli(name))) return { bin: name, args: [] };
  return null;
}

// Try the user's configured linters for `lang` in order. Returns the
// first linter's output, or null when none of the named linters are
// installed (caller falls back to default auto-detection).
async function lintWithConfig(lang, files, linterNames) {
  if (!Array.isArray(linterNames) || linterNames.length === 0) {
    // Empty list = lang disabled. Return empty-string sentinel so the
    // caller doesn't fall through to auto-detection.
    return '';
  }
  for (const name of linterNames) {
    const resolved = await resolveLinterByName(name, lang);
    if (!resolved) continue;
    return runLinter(name, resolved.bin, resolved.args, resolved.noFiles ? [] : files);
  }
  return null;
}

const EXT_LANG = [
  { re: /\.py$/i, lang: 'python' },
  { re: /\.(js|jsx|ts|tsx)$/i, lang: 'js-ts' },
  { re: /\.rs$/i, lang: 'rust' },
  { re: /\.go$/i, lang: 'go' },
  { re: /\.rb$/i, lang: 'ruby' },
  { re: /\.java$/i, lang: 'java' },
  { re: /\.[ch]$/i, lang: 'c' },
  { re: /\.(cpp|cc|cxx|hpp|hxx)$/i, lang: 'cpp' },
  { re: /\.cs$/i, lang: 'csharp' },
  { re: /\.swift$/i, lang: 'swift' },
  { re: /\.(sql|pls|plb|pks|pkb|trg|fnc|prc)$/i, lang: 'sql' },
  { re: /\.kt$/i, lang: 'kotlin' },
  { re: /\.php$/i, lang: 'php' },
];

function classify(files) {
  const byLang = new Map();
  for (const f of files) {
    for (const { re, lang } of EXT_LANG) {
      if (re.test(f)) {
        if (!byLang.has(lang)) byLang.set(lang, []);
        byLang.get(lang).push(f);
        break;
      }
    }
  }
  return byLang;
}

async function hasCli(name) {
  const r = await tryRun(name, ['--version'], { timeoutMs: 2000 });
  return r.exitCode === 0;
}

function localBin(name) {
  const p = path.join('node_modules', '.bin', name);
  try {
    const stat = fs.statSync(p);
    if (stat.isFile()) return p;
  } catch {
    /* ignore */
  }
  return null;
}

async function runLinter(label, file, args, files) {
  log.err(`LINTER:${label}`);
  const finalArgs = files && files.length > 0 ? [...args, ...files] : args;
  const r = await tryRun(file, finalArgs, { timeoutMs: 120_000 });
  if (typeof r.exitCode === 'number' && r.exitCode > 2) {
    log.err(`WARN: ${label} exited with code ${r.exitCode} (may have crashed)`);
  }
  return `${r.stdout}${r.stderr}`;
}

async function lintLanguage(lang, files) {
  if (lang === 'python') {
    if (await hasCli('ruff')) return runLinter('ruff', 'ruff', ['check'], files);
    if (await hasCli('flake8')) return runLinter('flake8', 'flake8', [], files);
    if (await hasCli('pylint'))
      return runLinter('pylint', 'pylint', ['--output-format=text'], files);
    return null;
  }
  if (lang === 'js-ts') {
    const eslintLocal = localBin('eslint');
    if (eslintLocal) return runLinter('eslint', eslintLocal, [], files);
    if (await hasCli('eslint')) return runLinter('eslint', 'eslint', [], files);
    if (await hasCli('biome')) return runLinter('biome', 'biome', ['check'], files);
    return null;
  }
  if (lang === 'rust') {
    if (await hasCli('cargo'))
      return runLinter('cargo-clippy', 'cargo', ['clippy', '--message-format=short'], []);
    return null;
  }
  if (lang === 'go') {
    if (await hasCli('golangci-lint'))
      return runLinter('golangci-lint', 'golangci-lint', ['run'], []);
    return null;
  }
  if (lang === 'ruby') {
    if (await hasCli('rubocop'))
      return runLinter('rubocop', 'rubocop', ['--format', 'simple'], files);
    return null;
  }
  if (lang === 'java') {
    if (await hasCli('checkstyle')) {
      // Only pass -c when a config file is actually present. The previous
      // hardcoded `/google_checks.xml` fallback was Linux-absolute and
      // crashed on macOS/Windows installs that lacked it.
      if (fs.existsSync('checkstyle.xml')) {
        return runLinter('checkstyle', 'checkstyle', ['-c', 'checkstyle.xml'], files);
      }
      return runLinter('checkstyle', 'checkstyle', [], files);
    }
    if (await hasCli('pmd')) return runLinter('pmd', 'pmd', ['check', '-d'], files);
    return null;
  }
  if (lang === 'c') {
    if (await hasCli('cppcheck'))
      return runLinter('cppcheck', 'cppcheck', ['--enable=warning,style'], files);
    if (await hasCli('clang-tidy')) return runLinter('clang-tidy', 'clang-tidy', [], files);
    return null;
  }
  if (lang === 'cpp') {
    if (await hasCli('cppcheck'))
      return runLinter('cppcheck', 'cppcheck', ['--enable=warning,style', '--language=c++'], files);
    if (await hasCli('clang-tidy')) return runLinter('clang-tidy', 'clang-tidy', [], files);
    return null;
  }
  if (lang === 'csharp') {
    if (await hasCli('dotnet'))
      return runLinter(
        'dotnet-format',
        'dotnet',
        ['format', '--verify-no-changes', '--diagnostics'],
        [],
      );
    return null;
  }
  if (lang === 'swift') {
    if (await hasCli('swiftlint'))
      return runLinter('swiftlint', 'swiftlint', ['lint', '--quiet'], files);
    return null;
  }
  if (lang === 'sql') {
    if (await hasCli('sqlfluff'))
      return runLinter('sqlfluff', 'sqlfluff', ['lint', '--dialect', 'oracle'], files);
    return null;
  }
  if (lang === 'kotlin') {
    if (await hasCli('ktlint')) return runLinter('ktlint', 'ktlint', [], files);
    if (await hasCli('detekt')) return runLinter('detekt', 'detekt', ['--input'], files);
    return null;
  }
  if (lang === 'php') {
    if (await hasCli('phpstan'))
      return runLinter('phpstan', 'phpstan', ['analyse', '--no-progress'], files);
    if (await hasCli('phpcs')) return runLinter('phpcs', 'phpcs', [], files);
    return null;
  }
  return null;
}

async function detectAndLint(files, lintersConfig) {
  const byLang = classify(files);
  if (byLang.size === 0) return null;
  const chunks = [];
  for (const [lang, langFiles] of byLang) {
    let out;
    if (lintersConfig && lintersConfig[lang]) {
      // User configured linters for this language — use their list.
      const configured = await lintWithConfig(lang, langFiles, lintersConfig[lang]);
      // null = none of the configured linters installed → fall back to
      // hardcoded auto-detect. '' = explicitly disabled (empty list) →
      // skip this language. string = a configured linter ran.
      if (configured === null) {
        out = await lintLanguage(lang, langFiles);
      } else if (configured === '') {
        out = null; // disabled
      } else {
        out = configured;
      }
    } else {
      out = await lintLanguage(lang, langFiles);
    }
    if (out !== null) chunks.push(out);
  }
  if (chunks.length === 0) return null;
  return chunks.join('\n');
}

const ERROR_RE = /(: error|: fatal|^ERROR|^FATAL|error:| E[0-9]{3,})/;

function splitErrorsAndWarnings(text) {
  const lines = splitLines(text);
  const errors = lines.filter((l) => ERROR_RE.test(l));
  const warnings = lines.filter((l) => !ERROR_RE.test(l) && l.trim() !== '');
  return { errors, warnings };
}

async function runOverride(name, files) {
  const localCli = localBin(name);
  if (localCli) return runLinter(name, localCli, [], files);
  if (await hasCli(name)) return runLinter(name, name, [], files);
  return null;
}

async function main() {
  const { opts } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    help();
    process.exit(0);
  }

  const limit = parseInt(opts.limit || '100', 10);
  const outputFile = opts['output-file'] || '';
  const override = opts.linter || '';
  let lintersConfig = null;
  if (opts['linters-json']) {
    try {
      lintersConfig = normalizeLintersConfig(JSON.parse(opts['linters-json']));
    } catch (e) {
      log.err(`WARN: invalid --linters-json: ${e.message}. Falling back to auto-detection.`);
    }
  }

  const modified = await tryGitStdout(['diff', '--name-only', 'HEAD']);
  const untracked = await tryGitStdout(['ls-files', '--others', '--exclude-standard']);
  const all = Array.from(new Set([...splitLines(modified || ''), ...splitLines(untracked || '')]))
    .filter(Boolean)
    .sort();

  if (all.length === 0) {
    log.out('No changed files to lint');
    process.exit(0);
  }

  let fullOutput;
  if (override) {
    fullOutput = await runOverride(override, all);
    if (fullOutput === null) {
      log.err(`WARN: Configured linter '${override}' not found, falling back to auto-detection`);
      fullOutput = await detectAndLint(all, lintersConfig);
    }
  } else {
    fullOutput = await detectAndLint(all, lintersConfig);
  }

  if (fullOutput === null) {
    log.out('No linter found for changed files');
    process.exit(2);
  }

  if (outputFile) {
    try {
      fs.writeFileSync(outputFile, fullOutput, 'utf8');
      log.err(`Full output saved to: ${outputFile}`);
    } catch (e) {
      log.err(`WARN: could not write lint output to ${outputFile}: ${e.message}`);
    }
  }

  const { errors, warnings } = splitErrorsAndWarnings(fullOutput);
  const errorCount = errors.length;
  const warnCount = warnings.length;
  const totalLines = countLines(fullOutput);

  let output = '';
  let remaining = limit;

  if (errors.length > 0) {
    const used = errors.slice(0, remaining);
    output = used.join('\n');
    remaining -= used.length;
  }

  if (remaining > 0 && warnings.length > 0) {
    const used = warnings.slice(0, remaining);
    output = output ? `${output}\n${used.join('\n')}` : used.join('\n');
  }

  if (output) log.out(output);

  if (totalLines > limit) {
    log.err(`... truncated (${totalLines} total lines, showing ${limit})`);
  }
  log.err(`Summary: ${errorCount} errors, ${warnCount} warnings`);

  process.exit(errorCount > 0 ? 1 : 0);
}

main().catch((e) => {
  log.error(e.message || String(e));
  process.exit(1);
});
