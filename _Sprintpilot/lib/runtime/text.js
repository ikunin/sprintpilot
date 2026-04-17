'use strict';

function splitLines(text) {
  if (!text) return [];
  const trimmedTrailing = text.replace(/\r?\n$/, '');
  if (trimmedTrailing === '') return [];
  return trimmedTrailing.split(/\r?\n/);
}

function headLines(text, n) {
  if (n <= 0) return '';
  const lines = splitLines(text);
  return lines.slice(0, n).join('\n');
}

function countLines(text) {
  return splitLines(text).length;
}

function extractUrl(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s"'<>)]+/);
  return m ? m[0] : null;
}

module.exports = { splitLines, headLines, countLines, extractUrl };
