'use strict';

const fs = require('node:fs');

// Keyword-based fuzzy matches (high false-positive rate, but useful as a
// last-resort catch for things like `API_KEY = "..."`).
const SECRET_KEYWORD = /API_KEY|SECRET|TOKEN|PASSWORD|aws_access|private_key/i;

// Concrete, high-confidence key prefixes / formats — these are what real
// secrets actually look like. Matching here is much less noisy than the
// keyword list above.
const SECRET_FORMATS = [
  /\bAKIA[0-9A-Z]{16}\b/,                  // AWS Access Key ID
  /\bASIA[0-9A-Z]{16}\b/,                  // AWS temporary Access Key ID
  /\bghp_[A-Za-z0-9]{30,}\b/,              // GitHub personal access token
  /\bgho_[A-Za-z0-9]{30,}\b/,              // GitHub OAuth token
  /\bghu_[A-Za-z0-9]{30,}\b/,              // GitHub user-to-server token
  /\bghs_[A-Za-z0-9]{30,}\b/,              // GitHub server-to-server token
  /\bghr_[A-Za-z0-9]{30,}\b/,              // GitHub refresh token
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,      // GitHub fine-grained PAT
  /\bsk-[A-Za-z0-9_-]{20,}\b/,             // OpenAI / Anthropic-like
  /\bsk_live_[A-Za-z0-9]{20,}\b/,          // Stripe live secret
  /\bsk_test_[A-Za-z0-9]{20,}\b/,          // Stripe test secret
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,      // Slack tokens
  /\bAIza[0-9A-Za-z_-]{35,99}\b/,          // Google API key (standard is 39 chars = AIza + 35)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,    // PEM private key header
];

// Deprecated: callers should use `matchesSecret(line)` which applies both
// the keyword list and the concrete-format list. Retained only for
// compatibility with anyone importing the old symbol.
const SECRET_PATTERN = SECRET_KEYWORD;

function matchesSecret(line) {
  if (SECRET_KEYWORD.test(line)) return true;
  for (const re of SECRET_FORMATS) {
    if (re.test(line)) return true;
  }
  return false;
}

function scanLinesForSecrets(text, maxHits = 3) {
  if (!text) return [];
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (matchesSecret(lines[i])) {
      out.push({ line: i + 1, text: lines[i] });
      if (out.length >= maxHits) break;
    }
  }
  return out;
}

function globToRegex(glob) {
  let src = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        src += '.*';
        i += 2;
        if (glob[i] === '/') i++;
      } else {
        src += '[^/]*';
        i++;
      }
      continue;
    }
    if (c === '?') {
      src += '[^/]';
      i++;
      continue;
    }
    if ('.+^$(){}|\\'.indexOf(c) !== -1) {
      src += '\\' + c;
      i++;
      continue;
    }
    if (c === '[') {
      const close = glob.indexOf(']', i);
      if (close === -1) {
        src += '\\[';
        i++;
        continue;
      }
      src += glob.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    src += c;
    i++;
  }
  src += '$';
  return new RegExp(src);
}

function parseAllowlist(filePath) {
  if (!filePath) return [];
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((glob) => ({ glob, regex: globToRegex(glob) }));
}

function isAllowlisted(filePath, patterns) {
  return patterns.some(({ regex }) => regex.test(filePath));
}

function isTextSafeSample(buf) {
  // Binary detection: any NUL byte -> binary.
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) return false;
  }
  return true;
}

function isBinaryFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      if (bytes === 0) return false;
      return !isTextSafeSample(buf.subarray(0, bytes));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

module.exports = {
  SECRET_PATTERN, // deprecated — prefer matchesSecret
  SECRET_FORMATS,
  matchesSecret,
  scanLinesForSecrets,
  globToRegex,
  parseAllowlist,
  isAllowlisted,
  isBinaryFile,
};
