# /bmad-update — Check and Install Add-On Updates

## Workflow

1. **Read current version** from `_bmad-addons/manifest.yaml` (the `version:` field under `addon:`).

2. **Check npm registry** for the latest published version:
   ```bash
   npm view bmad-autopilot-addon@latest version 2>/dev/null
   ```
   If npm is not available or the command fails, report the error and stop.

3. **Compare versions.**
   - If they match: report "BMAD Autopilot Add-On v{version} is up to date." and stop.
   - If a newer version exists: continue to step 4.

4. **Show what's new.** Fetch the changelog summary for the user:
   ```bash
   npm view bmad-autopilot-addon@latest readme 2>/dev/null | head -5
   ```
   Present to the user:
   ```
   Update available: {current} -> {latest}

   To see the full changelog: https://github.com/ikunin/bmad-autopilot-addon/releases
   ```

5. **Ask for confirmation.** HALT and wait for user approval:
   ```
   Install update? This will back up current skills and install v{latest}.
   [Y] Yes, update now
   [N] No, skip
   ```

6. **Install the update.** On confirmation, run:
   ```bash
   npx bmad-autopilot-addon@{latest} install --yes
   ```
   Stream the output so the user can see progress.

7. **Verify.** Read `_bmad-addons/manifest.yaml` again and confirm the version updated:
   ```
   Updated to v{latest}
   Previous version backed up to .claude/.addon-backups/
   ```
   If the version did not change, warn the user that the update may have failed.
