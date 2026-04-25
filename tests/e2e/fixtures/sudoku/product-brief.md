# Product Brief: Sudoku Web Game

## Vision

A browser-playable 9×9 Sudoku puzzle game with a modern, minimal UI. Single-player, generates fresh puzzles at three difficulty levels, validates moves in real time, and celebrates completion. Pure TypeScript + vanilla DOM — no UI framework, but the visual design is contemporary (clean grid, smooth highlights, readable typography).

## Target Users

Anyone who wants a quick Sudoku break in the browser without installing an app or signing up.

## Core Features

### 1. Sudoku Engine
- 9×9 board representation with cells holding values 0-9 (0 = empty).
- Move validation: a value placed in a cell must not violate row, column, or 3×3 box uniqueness.
- Completion detection: board is fully filled and all rows/columns/boxes contain digits 1-9.
- Pure logic, no DOM dependencies — fully unit-testable.

### 2. Puzzle Generator + Solver
- Backtracking solver that returns the unique solution for any partially-filled valid board (or null if unsolvable).
- Puzzle generator produces a puzzle + its solution for a chosen difficulty level (Easy / Medium / Hard). Difficulty is controlled by how many cells are pre-filled (Easy ≥ 40, Medium 30-39, Hard < 30).
- Generator guarantees the produced puzzle has at least one solution.
- Pure logic, fully unit-testable.

### 3. UI Shell + Cell Rendering
- Single HTML page (`index.html`) with a centered 9×9 grid.
- Modern CSS: light/dark friendly, system font stack, rounded-rectangle cells with subtle shadows, distinct border every 3 cells to mark the 3×3 boxes, hover/focus highlights, accessible color contrast.
- Renders a `Board` to the DOM. Pre-filled cells are visually distinct from user-entered cells.
- No game logic in this layer — purely a view of a board.

### 4. Game Interactivity + Polish
- Click a cell to select it; type a digit 1-9 to fill it; Backspace/Delete clears it. Arrow keys move the selection.
- Invalid placements are highlighted in red but allowed (the player can correct them).
- Difficulty selector (Easy / Medium / Hard) and a "New Puzzle" button reset the board with a fresh puzzle.
- Win celebration: when the board is correctly completed, show a brief congratulations overlay.
- Optional hint button: fills the selected cell with the correct value from the cached solution.

## Technical Requirements

- Language: TypeScript (strict mode).
- Build tool: Vite (`npm run dev` serves a hot-reloading dev server on port 5173).
- Test framework: Vitest. UI tests use `happy-dom` (already a dev dep added by the test scaffold) so the DOM layer is testable without a browser.
- Zero runtime dependencies — vanilla DOM, no frameworks (no React/Vue/Svelte/Lit).
- All engine + generator logic in pure functions (no DOM imports outside the UI layer).
- Source layout:
  - `src/engine/` — board, validator, solver, generator (pure logic)
  - `src/ui/` — board rendering, input handling, game wiring (DOM)
  - `src/styles/` — CSS
  - `src/main.ts` — entry point that bootstraps the game
  - `index.html` — Vite entry document

## Out of Scope

- User accounts / leaderboards / persistence beyond the current session
- Network multiplayer
- Hand-curated puzzles (generator-only)
- Pencil marks / candidate annotations
- Mobile touch optimization beyond what flexbox-based responsive layout gives for free
- Internationalization
