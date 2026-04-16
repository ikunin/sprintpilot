'use strict';

const path = require('node:path');

const TEXT_EXTENSIONS = new Set([
  '.md', '.yaml', '.yml', '.json', '.sh', '.txt',
]);

function isTextFile(filePath) {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function renderString(text, ctx) {
  if (!text) return text;
  let out = text;
  for (const [key, value] of Object.entries(ctx)) {
    if (value == null) continue;
    const token = `{${key}}`;
    if (out.includes(token)) {
      out = out.split(token).join(value);
    }
  }
  return out;
}

function buildContext({ outputFolder }) {
  const out = outputFolder || '_bmad-output';
  return {
    output_folder: out,
    planning_artifacts: `${out}/planning-artifacts`,
    implementation_artifacts: `${out}/implementation-artifacts`,
  };
}

module.exports = {
  isTextFile,
  renderString,
  buildContext,
};
