# Changelog

## 0.1.0

- Automatically detect the remote default branch and compare against its merge base.
- Decorate committed, staged, unstaged, unsaved, and untracked file changes.
- Add change navigation, baseline diff, and undoable hunk restoration.
- Support configurable colors, size limits, multiple repositories, and linked worktrees.
- Update automatically as files, Git references, and repository boundaries change.
- Cache comparisons and remote lookups, and pause polling in background windows.
- Skip ignored files and Git metadata; use VS Code's Git executable or discover it from configured paths and PATH.
- Require valid UTF-8 baselines for comparisons and restoration.
