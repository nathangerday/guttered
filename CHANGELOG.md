# Changelog

## 0.4.5

- Distinguish local edits (native colored Git gutter bars) from committed branch changes (subdued violet line shading and dashed deletion boundaries).
- Remove all text spacers, injected hints, and marker hover targets to preserve caret alignment, wrapping, breakpoint clicks, and documentation hovers.
- Add **Peek Change**: a read-only, syntax-colored merge-base diff below the source line, available through the editor context menu or Ctrl+K, Ctrl+Alt+D (Cmd on macOS).
- Exclude staged, unstaged, and unsaved lines from branch shading using HEAD and index comparisons, while retaining them in the tree, previews, navigation, and restore.
- Cache immutable HEAD/index blobs and reuse unchanged comparisons on idle refreshes.
- Replace the three branch marker colors with `guttered.colors.branch`. Require VS Code 1.100 for native staged-change indicators.

## 0.4.3

- Keep the Source Control icon's count limited to VS Code's local changes by removing Guttered's branch-change badge.

## 0.4.2

- Explain merge-base comparison with a branch-history diagram and screenshots of the markers, changed-files tree, and hover preview.
- Add a Marketplace publishing command and document CLI authentication and release steps.

## 0.4.1

- Fix the invisible Toggle On/Off button in the Branch Changes toolbar by using a supported VS Code icon.

## 0.4.0

- Toggle Guttered on or off for the whole workspace from the actions menu or Command Palette; remember the choice without changing per-folder settings.
- Show a folder tree of changed files in Source Control, using the selected merge base and including unsaved buffers. Click a file to open its diff against that merge base, with empty sides for added and deleted files.
- Use the file icon theme and colored A/M/D badges in the changed-files tree.
- Update the tree automatically while visible, and stop comparison work when Guttered is off.

## 0.3.0

- Filter available local and remote-tracking branches when choosing the comparison reference, with the automatic default branch first.
- Preview merge-base changes by hovering over a marker, with a link to open VS Code's diff view at that change.
- Keep marker previews separate from language documentation, without changing the text inset. Previews require visible inlay hints with padding off.

## 0.2.0

- Move change markers into a consistent 8 px inset before the text, leaving breakpoint clicks and other gutter controls available.
- Use softer markers at 30% opacity by default, configurable with `guttered.opacity`.
- Keep indentation guides aligned across empty lines with the inset enabled.
- Join bars on adjacent changed lines, including with custom line spacing.

## 0.1.0

- Automatically detect the remote default branch and compare against its merge base.
- Decorate committed, staged, unstaged, unsaved, and untracked file changes.
- Add change navigation, baseline diff, and undoable hunk restoration.
- Support configurable colors, size limits, multiple repositories, and linked worktrees.
- Update automatically as files, Git references, and repository boundaries change.
- Cache comparisons and remote lookups, and pause polling in background windows.
- Skip ignored files and Git metadata; use VS Code's Git executable or discover it from configured paths and PATH.
- Require valid UTF-8 baselines for comparisons and restoration.
