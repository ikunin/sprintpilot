# Sprintpilot — Dependency Graph Renderer

## Purpose

Render the sprint dependency graph from `sprint-plan.yaml` in a
user-chosen format without requiring shell commands. Wraps
`resolve-dag.js` (`render` / `graph` / `layers` / `width`) so the user
just types `/sprintpilot-dependency-graph mermaid` (or interactive
prompt) and the visualization lands in chat.

## Outputs

- For **mermaid** + **text** + **layers** + **json** → rendered inline
  in chat. Mermaid additionally writes a `.mmd` file (default
  `_bmad-output/implementation-artifacts/sprint-plan-dag.mmd`) so the
  user can preview in any markdown viewer.
- For **graphviz** → writes a `.dot` file (default
  `_bmad-output/implementation-artifacts/sprint-plan-dag.dot`); reports
  the path. No inline render (chat doesn't render dot directly).

No file mutations beyond the rendered output file.

## Conventions

- `<root>` = project root.
- All formats accept an optional `--epic <id>` scope. When set,
  cross-epic edges are filtered out; only intra-epic structure renders.
- All formats accept an optional `--output <path>` for the file modes
  (mermaid / graphviz).
- Mermaid is the default when ambiguity needs to be resolved — it's
  the most portable (GitHub-renderable, no system deps).

---

## Step 1 — Parse the User's Invocation

<action>The user invoked this skill with optional arguments. Parse:

1. **Format** (one of `mermaid` / `graphviz` / `text` / `layers` / `json`).
   Accept synonyms:
   - "mermaid" / "mmd" → mermaid
   - "graphviz" / "dot" → graphviz
   - "text" / "tree" / "plain" → text
   - "layers" / "parallel" / "topo" → layers
   - "json" / "raw" → json

2. **Epic scope** (optional). Match `epic <id>` / `--epic <id>` / `for epic <id>`.

3. **Output path** (optional). Match `--output <path>` / `to <path>`.

If the user provided a format → skip Step 2.
If they didn't → proceed to Step 2.</action>

---

## Step 2 — Ask for Format (When Ambiguous)

<action>Only when the user invoked with no format argument, present a
single multi-choice prompt:

> Which format?
>   [m] mermaid    — visual flowchart (default; GitHub-renderable, no deps)
>   [g] graphviz   — .dot file for the dot toolchain (requires `dot` in PATH)
>   [t] text       — topological tree rendered inline
>   [l] layers     — JSON of parallel-eligible groups [[a], [b,c], ...]
>   [j] json       — raw graph {nodes, edges, epic}

Default to mermaid on empty input. If the user types something
ambiguous, ask once more; don't default silently — they explicitly
declined to pick a default.</action>

---

## Step 3 — Verify the Plan Exists

<action>Check that `sprint-plan.yaml` exists and is readable:
```
node _Sprintpilot/scripts/sprint-plan.js read --project-root <root>
```

Three branches:

- **`exists: false`** → halt politely:
  > "No sprint plan found at `_bmad-output/implementation-artifacts/sprint-plan.yaml`.
  > Run `/sprintpilot-plan-sprint` to build one, then re-invoke this
  > skill to render the graph."
  Do NOT attempt to render an empty graph.

- **`exists: true, error: ...`** → corrupt plan file. Surface the
  error message and halt:
  > "sprint-plan.yaml exists but is unreadable: `<error message>`.
  > Inspect manually, or run `/sprintpilot-plan-sprint` to rebuild
  > from scratch."

- **Valid plan** → proceed to Step 4.

Also note: if `plan.stories` is `[]` (skill curation not yet done),
the resolver still works — it falls back to sprint-status order. Mention
that in the output so the user knows the graph isn't yet curation-aware.</action>

---

## Step 4 — Render

<action>Pick the right `resolve-dag.js` subcommand based on the chosen
format. All commands accept `--project-root <root>` and optionally
`--epic <id>`.

### Mermaid (default)

```
node _Sprintpilot/scripts/resolve-dag.js render --format mermaid \
  [--epic <id>] [--output <path>] --project-root <root>
```

Returns JSON `{wrote, file, format, nodes, edges, fallback?, png_file?, png_reason?, png_message?}`.
Then read the rendered file and inline its contents in a ```mermaid fenced
code block so the chat client (Claude Code, etc.) renders the diagram
inline. Also report the file path so the user can preview elsewhere:

> Rendered to `<file>`. Below is the inline mermaid:
> ```mermaid
> flowchart LR
>   subgraph epic_1 ["PROJ-100: Epic 1"]
>     1-1-bootstrap["PROJ-101: 1-1-bootstrap"]:::done
>     1-3-add-auth["1-3-add-auth"]:::pending   ← no issue_id set
>   end
>   ...
> ```

When `plan.stories[*].issue_id` or `plan.epics[*].issue_id` is set, the
renderer prefixes the visual label with `<issue_id>: ` so the diagram
cross-references back to the user's tracker (Jira / Linear / GitHub /
GitLab). Stories/epics without an issue_id render with the bare key —
silence communicates "not tracked" rather than spamming `[no issue]`.

**PNG sibling render.** As a side-effect of the mermaid render, the
script tries to produce a `<file>.png` next to the `.mmd` via the
official Mermaid CLI (`mmdc`). You **MUST** examine the envelope's
`png_*` fields and surface one of the three outcomes to the user —
silence is a bug, especially when mmdc is missing.

- **`png_file` set** → PNG produced. Report:
  > Also wrote PNG: `<png_file>` (rendered via Mermaid CLI).

- **`png_reason: "mmdc-missing"`** → Mermaid CLI is not installed.
  You **MUST** tell the user how to install it, verbatim:
  > PNG render skipped — Mermaid CLI (`mmdc`) is not installed.
  > To get a `.png` alongside the `.mmd` next time, install it:
  >
  > ```
  > npm install -g @mermaid-js/mermaid-cli
  > ```
  >
  > Works on Windows, Linux, and macOS. Requires Node 18+.
  > After installing, re-run `/sprintpilot-dependency-graph mermaid`.

  Do not silently drop this. The `.mmd` file is still useful but the
  install hint is the primary value of this code path.

- **`png_reason: "render-failed"`** → mmdc was found but errored.
  Report the `png_message` verbatim and suggest re-running with
  `mmdc -i <mmd-path> -o <png-path>` outside the skill to see the
  full toolchain error.

### Graphviz

```
node _Sprintpilot/scripts/resolve-dag.js render --format graphviz \
  [--epic <id>] [--output <path>] --project-root <root>
```

If the result envelope has `fallback: 'graphviz-missing'`, the script
silently rendered mermaid instead — surface that clearly to the user:

> Graphviz toolchain (`dot`) not found in PATH; fell back to mermaid.
> Output: `<mmd path>`. Install graphviz (e.g., `brew install graphviz`,
> `apt install graphviz`) to get .dot output.

Otherwise, report:

> Rendered to `<dot path>`. Render to PNG with:
>   `dot -Tpng <dot path> -o dag.png`

### Text (topological tree)

```
node _Sprintpilot/scripts/resolve-dag.js layers \
  [--epic <id>] --project-root <root>
```

Returns JSON `[[layer1], [layer2], ...]`. Render in chat as a tree:

> Sprint DAG (topological layers — items in the same layer have no
> mutual dependency and could run in parallel):
>
>   Layer 1: 1-1-bootstrap, 1-2-models
>   Layer 2: 1-3-add-auth
>   Layer 3: 2-1-foo
>   ...
>
> Width: <N>  (max parallel-eligible stories at any single layer)

### Layers (raw JSON)

```
node _Sprintpilot/scripts/resolve-dag.js layers \
  [--epic <id>] --project-root <root>
```

Pretty-print the JSON array directly:

> ```json
> [
>   ["1-1-bootstrap", "1-2-models"],
>   ["1-3-add-auth"],
>   ["2-1-foo"]
> ]
> ```

### JSON (full graph)

```
node _Sprintpilot/scripts/resolve-dag.js graph \
  [--epic <id>] --project-root <root>
```

Pretty-print the JSON `{nodes, edges, epic}`:

> ```json
> {
>   "nodes": ["1-1-bootstrap", "1-2-models", "1-3-add-auth", "2-1-foo"],
>   "edges": [
>     ["1-1-bootstrap", "1-3-add-auth"],
>     ["1-2-models", "1-3-add-auth"],
>     ["1-3-add-auth", "2-1-foo"]
>   ],
>   "epic": null
> }
> ```

In every mode, surface counts at the end: "N nodes, M edges,
K cross-epic" (compute cross-epic by counting edges whose endpoints
have different leading hyphen segments — leverage the JSON output).</action>

---

## Failure modes

| Symptom | Recovery |
|---|---|
| Plan file missing | Halt with pointer to `/sprintpilot-plan-sprint`. Do NOT auto-build. |
| Plan file corrupt | Surface the parse error from `sprint-plan.js read`; suggest re-running the planning skill. |
| Cycle detected (`resolve-dag.js` exits 1 with "cycle detected") | Report the cycling node list verbatim. Suggest reviewing `plan.dependencies.stories` for the named keys, or re-running `/sprintpilot-plan-sprint` to re-infer. |
| Graphviz binary missing | Note the fallback; tell the user how to install `dot`; do NOT silently retry with a different format. |
| Mermaid CLI (`mmdc`) missing (mermaid format, `png_reason: "mmdc-missing"`) | You **MUST** report the install command: `npm install -g @mermaid-js/mermaid-cli` (cross-platform, requires Node 18+). The `.mmd` file is still written, but never skip the install hint — that's the user-actionable signal. |
| Mermaid CLI present but errored (`png_reason: "render-failed"`) | Surface `png_message` verbatim; suggest re-running `mmdc -i <mmd> -o <png>` outside the skill to see the full toolchain error. |
| Output file write fails (permission, disk full) | Surface the error from the resolve-dag stderr; chat-render the JSON output as a fallback so the user still gets something usable. |
