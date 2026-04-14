Bump the version, commit, push, tag, and create a GitHub release to publish a new npm version.

If the user provides a argument, use it as the version bump type (patch, minor, major). Default to patch.

Steps:

1. **Determine the new version.**
   - Read the current version from `package.json`.
   - Bump it according to the requested type (patch/minor/major) following semver.

2. **Update version in ALL of these files:**
   - `package.json` — the `"version"` field
   - `README.md` — the heading `# BMAD Autopilot Add-On v<version>`
   - `_bmad-addons/manifest.yaml` — the `version:` field under `addon:`
   - `CHANGELOG.md` — prepend a new `## [<version>] - <today's date>` section at the top (after the `# Changelog` heading). Leave the body as `### Changed\n- <summarize unreleased changes from git log since last tag>`.

3. **Stage and commit** (explicitly by filename, never `git add -A`):
   ```
   git add package.json README.md _bmad-addons/manifest.yaml CHANGELOG.md
   git commit -m "release: v<version>"
   ```

4. **Push to main:**
   ```
   git push origin main
   ```

5. **Create a git tag and GitHub release.**
   Use the GitHub MCP tools (search for them via ToolSearch if needed):
   - First, get the commit SHA of HEAD after pushing
   - Create the release with tag `v<version>` targeting `main`, using the CHANGELOG entry as the release body
   - The GitHub Actions workflow (`.github/workflows/publish.yml`) triggers on release publish and runs `npm publish`

6. **Report:**
   ```
   Published v<version>

   Updated: package.json, README.md, manifest.yaml, CHANGELOG.md
   Tag: v<version>
   Release: <release URL>
   npm publish will be triggered by CI.
   ```
