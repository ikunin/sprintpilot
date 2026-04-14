Stage all changes, commit with a descriptive message, and push to main.

Rules:
- NEVER use `git add -A` or `git add .` — stage files explicitly by name
- Do NOT stage files that contain secrets (.env, credentials, API keys, tokens)
- Draft a concise commit message that follows the style of recent commits in this repo
- If not on main, checkout main first
- Push to origin main; if rejected, pull --rebase then push
- Report the commit SHA and message when done
