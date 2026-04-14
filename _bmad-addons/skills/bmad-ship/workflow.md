# BMAD Ship — Commit & Push to Main

## Purpose

Stage all changes, commit with a descriptive message, and push to main. A single command to ship work that is ready to go.

---

<workflow>

<step n="1" goal="Verify there are changes to ship">

<action>Run `git status --porcelain` to check for uncommitted changes (staged, unstaged, or untracked).</action>

<check if="no changes found">
  <action>Report: "Nothing to ship — working tree is clean."</action>
  <action>STOP</action>
</check>

<action>Run `git diff --stat` and `git diff --cached --stat` to summarize what will be committed.</action>
<action>Run `git log --oneline -5` to see recent commit message style.</action>

</step>

<step n="2" goal="Stage and commit">

<action>**Stage all changed and new files explicitly** — NEVER use `git add -A` or `git add .`.
List each changed/new file by name from the status output and stage them individually:
```
git add -- "file1" "file2" ...
```
Do NOT stage files that likely contain secrets (.env, credentials.json, API keys, tokens).
If any such files are detected, warn the user and exclude them.
</action>

<action>**Draft a commit message** by analyzing the staged changes:
- Summarize the nature of the changes (feature, fix, docs, refactor, test, etc.)
- Keep it concise (1-2 sentences) and focus on the "why" not the "what"
- Follow the commit message style from recent history
</action>

<action>**Commit** with the drafted message.</action>

</step>

<step n="3" goal="Push to main">

<action>Ensure we are on the main branch:
```
git checkout main
```
If not on main and the commit was made on another branch, merge to main first:
```
git checkout main
git merge <branch> --no-edit
```
</action>

<action>**Push to remote**:
```
git push origin main
```
If push fails due to remote changes:
```
git pull --rebase origin main
git push origin main
```
</action>

<action>Report:
```
Shipped to main

Commit: <sha> <message>
Push: origin/main
```
</action>

</step>

</workflow>
