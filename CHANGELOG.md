# Changelog

## 0.5.1

- Refresh the dark and light screenshots for the default glyph-margin placement, show the gutter menu alongside VS Code's breakpoint actions, and update the diff and inset-hover examples.
- Keep deletion markers at their boundary on wrapped lines.
- Hide gutter actions in non-file editors and cancel diff or restore commands if the document changes while switching editors.

## 0.5.0

- Show markers in the glyph margin alongside breakpoints by default. Clicking a changed line there doesn't add a breakpoint, so use the gutter's right-click menu or F9. Set `guttered.gutterPlacement` to `inset` for the previous placement, which keeps breakpoint clicks free and previews changes on hover.
- Right-click the line number or glyph margin of a changed line to open the diff or restore the change at that line.
- Fix **Open Diff with Merge Base** in the editor's Guttered context menu, which reported an invalid diff target.

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
