# PRD: CLI Tic Tac Toe

> This is the **PRD** — the mandatory BMad authoring artifact consumed by
> `bmad-create-architecture` and `bmad-create-epics-and-stories`. The
> (optional) product brief is upstream discovery and not what
> `bmad-create-story` reads.

## Problem

Developers and terminal enthusiasts want a quick local-multiplayer Tic
Tac Toe game playable straight from the command line, with no install
beyond `npm i` and no GUI.

## Goals

A two-player, single-process CLI Tic Tac Toe in TypeScript + Node, with
all game logic pure-functional and unit-tested.

## Functional requirements

### 1. Game board display
- 3×3 grid rendered in the terminal using ASCII characters.
- Clear visual distinction between X and O markers.
- Board redraws after each move.

### 2. Player input
- Players alternate turns (Player X goes first).
- Input via position number 1-9 corresponding to board cells.
- Invalid moves rejected with a clear message (occupied cell, out of
  range).

### 3. Win detection
- Detect winning condition: three in a row (horizontal, vertical,
  diagonal).
- Announce the winner (Player X or Player O).

### 4. Draw detection
- Detect when all cells are filled with no winner.
- Announce a draw.

### 5. Game flow
- Game starts immediately on launch.
- After game ends, option to play again or quit.

## Non-functional requirements

- Language: TypeScript.
- Runtime: Node.js.
- Test framework: Vitest.
- No external dependencies beyond dev tooling.
- All game logic in pure functions (easily testable).

## Out of scope

- AI opponent.
- Network multiplayer.
- GUI or web interface.
- Score tracking across games.
