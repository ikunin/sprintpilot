#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { parseArgs } = require('../lib/runtime/args');
const { tryRun } = require('../lib/runtime/spawn');
const { tryGitStdout } = require('../lib/runtime/git');
const { splitLines, countLines, headLines } = require('../lib/runtime/text');
const log = require('../lib/runtime/log');

function help() {
  log.out('Usage: lint-changed.js [--limit 100] [--output-file path] [--linter <tool>]');
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
  } catch { /* ignore */ }
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
    if (await hasCli('pylint')) return runLinter('pylint', 'pylint', ['--output-format=text'], files);
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
    if (await hasCli('cargo')) return runLinter('cargo-clippy', 'cargo', ['clippy', '--message-format=short'], []);
    return null;
  }
  if (lang === 'go') {
    if (await hasCli('golangci-lint')) return runLinter('golangci-lint', 'golangci-lint', ['run'], []);
    return null;
  }
  if (lang === 'ruby') {
    if (await hasCli('rubocop')) return runLinter('rubocop', 'rubocop', ['--format', 'simple'], files);
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
    if (await hasCli('cppcheck')) return runLinter('cppcheck', 'cppcheck', ['--enable=warning,style'], files);
    if (await hasCli('clang-tidy')) return runLinter('clang-tidy', 'clang-tidy', [], files);
    return null;
  }
  if (lang === 'cpp') {
    if (await hasCli('cppcheck')) return runLinter('cppcheck', 'cppcheck', ['--enable=warning,style', '--language=c++'], files);
    if (await hasCli('clang-tidy')) return runLinter('clang-tidy', 'clang-tidy', [], files);
    return null;
  }
  if (lang === 'csharp') {
    if (await hasCli('dotnet')) return runLinter('dotnet-format', 'dotnet', ['format', '--verify-no-changes', '--diagnostics'], []);
    return null;
  }
  if (lang === 'swift') {
    if (await hasCli('swiftlint')) return runLinter('swiftlint', 'swiftlint', ['lint', '--quiet'], files);
    return null;
  }
  if (lang === 'sql') {
    if (await hasCli('sqlfluff')) return runLinter('sqlfluff', 'sqlfluff', ['lint', '--dialect', 'oracle'], files);
    return null;
  }
  if (lang === 'kotlin') {
    if (await hasCli('ktlint')) return runLinter('ktlint', 'ktlint', [], files);
    if (await hasCli('detekt')) return runLinter('detekt', 'detekt', ['--input'], files);
    return null;
  }
  if (lang === 'php') {
    if (await hasCli('phpstan')) return runLinter('phpstan', 'phpstan', ['analyse', '--no-progress'], files);
    if (await hasCli('phpcs')) return runLinter('phpcs', 'phpcs', [], files);
    return null;
  }
  return null;
}

async function detectAndLint(files) {
  const byLang = classify(files);
  if (byLang.size === 0) return null;
  const chunks = [];
  for (const [lang, langFiles] of byLang) {
    const out = await lintLanguage(lang, langFiles);
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
  if (opts.help) { help(); process.exit(0); }

  const limit = parseInt(opts.limit || '100', 10);
  const outputFile = opts['output-file'] || '';
  const override = opts.linter || '';

  const modified = await tryGitStdout(['diff', '--name-only', 'HEAD']);
  const untracked = await tryGitStdout(['ls-files', '--others', '--exclude-standard']);
  const all = Array.from(
    new Set([...splitLines(modified || ''), ...splitLines(untracked || '')])
  ).filter(Boolean).sort();

  if (all.length === 0) {
    log.out('No changed files to lint');
    process.exit(0);
  }

  let fullOutput;
  if (override) {
    fullOutput = await runOverride(override, all);
    if (fullOutput === null) {
      log.err(`WARN: Configured linter '${override}' not found, falling back to auto-detection`);
      fullOutput = await detectAndLint(all);
    }
  } else {
    fullOutput = await detectAndLint(all);
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
