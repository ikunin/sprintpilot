const TOOL_DIRS = {
  'claude-code': '.claude',
  cursor: '.cursor',
  windsurf: '.windsurf',
  cline: '.cline',
  roo: '.roo',
  trae: '.trae',
  kiro: '.kiro',
  'github-copilot': '.github/copilot',
  'gemini-cli': '.gemini',
};

const SYSTEM_PROMPT_FILES = {
  'claude-code': 'AGENTS.md',
  cursor: '.cursor/rules/bmad.md',
  windsurf: '.windsurfrules',
  cline: '.clinerules',
  roo: '.roo/rules/bmad.md',
  'gemini-cli': 'GEMINI.md',
  'github-copilot': '.github/copilot-instructions.md',
  kiro: '.kiro/rules/bmad.md',
  trae: '.trae/rules/bmad.md',
};

const SYSTEM_PROMPT_MODES = {
  'claude-code': 'claude-code',
  cursor: 'own-file',
  roo: 'own-file',
  kiro: 'own-file',
  trae: 'own-file',
  windsurf: 'append',
  cline: 'append',
  'gemini-cli': 'append',
  'github-copilot': 'append',
};

const ALL_TOOLS = [
  'claude-code',
  'cursor',
  'windsurf',
  'gemini-cli',
  'cline',
  'roo',
  'trae',
  'kiro',
  'github-copilot',
];

function getToolDir(tool) {
  return TOOL_DIRS[tool] || '';
}

function getSystemPromptFile(tool) {
  return SYSTEM_PROMPT_FILES[tool] || '';
}

function getSystemPromptMode(tool) {
  return SYSTEM_PROMPT_MODES[tool] || '';
}

function isKnownTool(tool) {
  return Object.hasOwn(TOOL_DIRS, tool);
}

module.exports = {
  ALL_TOOLS,
  getToolDir,
  getSystemPromptFile,
  getSystemPromptMode,
  isKnownTool,
};
