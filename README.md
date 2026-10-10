# Guttered

<img src="assets/icon.png" alt="Guttered logo" width="96" height="96">

Guttered shows your branch's changes in the normal VS Code editor, including committed, staged, unstaged, and unsaved edits. It also marks new and untracked files that Git isn't ignoring.

The comparison starts at a **merge base**: a common ancestor of your branch and the repository's default branch, selected by Git. Changes made only on the default branch after that point stay out of your indicators.

Added lines have soft green bars, modified lines have soft yellow bars, and deleted lines have soft red triangles on the neighboring line. Markers use 30% opacity by default, keeping native Git indicators more prominent on both dark and light themes. Markers sit in an 8 px inset before the text, leaving breakpoint clicks, line numbers, folding controls, and native Git markers available. Unchanged lines use the same inset to keep the code aligned. The overview ruler also shows the changes; text backgrounds stay unchanged.

## Install

You need desktop VS Code, Git 2.30 or newer, and a trusted workspace. Guttered uses the Git executable found by VS Code's built-in Git extension. If that extension is disabled, it tries `git.path` (a path or a list of candidates), then Git on PATH. Reload the window after changing the Git executable.

The extension supports VS Code 1.95 and newer.

Install [Guttered from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=nathangerday.guttered), or search for `nathangerday.guttered` in VS Code's Extensions view. Open a file in a Git repository to start comparing automatically.

If you installed an earlier GitHub VSIX, uninstall that copy before installing the Marketplace version. The publisher ID changed from `guttered` to `nathangerday`, so VS Code treats them as separate extensions. Your `guttered.*` settings still apply.

To build the extension from this repository, use Node.js 22 or newer:

```sh
npm ci
npm run package
```

## Use Guttered

The status bar shows the selected reference, such as `origin/trunk (merge-base)`. Hover for the current branch, merge-base SHA, and comparison state. Click it to open the actions menu.

Hover over a branch-change marker to preview the removed and added lines. Click **Open Diff with Merge Base** in the hover to open VS Code's diff view at that change, including unsaved edits. Large previews are shortened; the diff view shows the full comparison.

Marker previews stay separate from code documentation. They require visible inlay hints and **Editor: Inlay Hints: Padding** turned off (VS Code's defaults). If hints are hidden or padded, the markers and **Guttered: Open Diff with Merge Base** command still work.

**Guttered: Toggle On/Off** disables or enables Guttered across the current workspace. Turning it off removes markers and previews, clears the changed-files view, and stops comparison updates. The choice is remembered for that workspace; enabling Guttered again preserves your per-folder settings and unsaved edits.

The **Guttered: Branch Changes** section in Source Control lists changed files from the active file's repository, grouped under their parent folders. It uses the selected reference's merge base and includes committed, staged, unstaged, untracked, and unsaved changes. With no file selected, it uses the first workspace folder. Files use your file icon theme, with **A** (green), **M** (blue), and **D** (red) badges for added, modified, and deleted files. Badge colors follow your theme's Git gutter colors. Click a file to compare its read-only merge-base version on the left with the working file, including unsaved edits, on the right. Added files have an empty left side; deleted files have an empty right side. Baseline loading keeps the existing text and size limits. Renames appear as a deletion and an addition, matching the gutter's path-based comparison.

The tree updates automatically while visible. It lists saved file changes through Git and applies open, unsaved buffers on top, so restoring a buffer to the baseline removes that file from the list. Binary and large files can appear in the tree even when their gutter comparison is unavailable. The view's toolbar offers toggle, reference selection, and refresh.

A *hunk* is a group of adjacent changed lines. The available actions are:

- **Toggle On/Off** pauses or resumes Guttered for this workspace. The status bar menu labels the action **Disable Guttered** or **Enable Guttered**.
- **Show Changed Files** opens the branch-changes tree in Source Control.
- **Open Diff with Merge Base** compares the merge-base version with your current editor contents, including unsaved edits.
- **Go to Next/Previous Change** moves between hunks, wrapping at either end of the file.
- **Restore Change from Merge Base** restores the hunk at the cursor. Put the cursor on a line with a deletion triangle to bring deleted lines back. Restoration edits the buffer and supports normal **Undo**; it does not save or stage. It can reverse committed branch changes in your working file.
- **Change Base Reference** lists local and remote-tracking branches from the file's repository. Type to filter them, or choose **Default branch (automatic)** at the top to return to the default branch. **Enter another Git reference…** accepts a tag, commit, or other reference. Every choice compares from its merge base with HEAD.
- **Refresh Comparison** checks again and clears cached failures. Normal operation is automatic.

All actions appear in the Command Palette and status bar menu. The **Guttered** editor context menu contains diff, navigation, and restore. You can assign shortcuts in VS Code's Keyboard Shortcuts editor; Guttered doesn't install default bindings.

Base-reference overrides apply to the current workspace folder, so repositories nested in that folder share the override. For a file outside every workspace folder, the command updates user settings and affects all workspaces. The picker states which scope it will change. It lists branches already available locally; it does not fetch.

## How comparison works

Guttered identifies the repository containing each visible file. It reads `origin/HEAD` to find the default branch, using the first remote when there is no `origin`. If the symbolic reference is missing, `git ls-remote --symref` contacts the remote to ask for its default branch. Both successful and failed remote lookups are cached for five minutes; **Refresh Comparison** clears that cache. If the remote-tracking branch is unavailable, Guttered tries the corresponding local branch.

The baseline is `git merge-base HEAD <base-reference>`. Guttered reads the file at that commit with `git show` and calculates a line diff against the live editor buffer. This includes unsaved edits and keeps the comparison tied to the common ancestor as the default branch advances.

Typing updates the indicators after a 250 ms pause by default. Git events and a three-second poll handle branch switches, rebases, merges, resets, fetches, changes to ignore rules, and new nested repositories. Polling pauses while the VS Code window is in the background and resumes when it gains focus. Only visible documents receive line comparisons; the changed-files tree also includes unsaved buffers from other open documents. Cached baselines, diffs, and saved-file lists avoid repeated work while typing. A hidden tree does not scan the repository.

Guttered's Git operations are read-only. It never fetches, changes refs, stages files, or changes Git configuration.

## Settings

All settings support workspace-folder overrides.

| Setting | Default | Purpose |
| --- | --- | --- |
| `guttered.enabled` | `true` | Enable continuous comparisons |
| `guttered.baseReference` | `""` | Detect the remote default branch; optionally use an explicit reference |
| `guttered.debounceMs` | `250` | Delay after typing, in milliseconds |
| `guttered.maxFileSizeKB` | `1024` | Maximum size of either file, in KiB |
| `guttered.gutter` | `true` | Show markers and the small inset before the text |
| `guttered.overviewRuler` | `true` | Show overview ruler markers |
| `guttered.opacity` | `0.3` | Marker opacity, from invisible (`0`) to fully opaque (`1`) |
| `guttered.colors.added` | `#4CAF50` | Added line color |
| `guttered.colors.modified` | `#E6A817` | Modified line color |
| `guttered.colors.deleted` | `#F44336` | Deletion marker color |

## Troubleshooting and limits

When a comparison is unavailable, hover over the status item or open **Output → Guttered** for the reason. A repository needs an existing commit and a locally available base reference with shared history. Repositories without a remote need an explicit **Base Reference** setting. A missing branch may need fetching, and shallow or unrelated history may need more history or another base.

If default-branch detection cannot reach the remote, restore network or authentication access and run **Guttered: Refresh Comparison**. You can also set **Base Reference** to a locally available branch and compare offline. To record the remote's default branch in Git, run `git remote set-head origin --auto` once access is restored, replacing `origin` if your remote has another name.

VS Code's native Git bars compare against HEAD and the index, so they can appear alongside Guttered's branch comparison with different markers. Use `scm.diffDecorations` to control the native bars; setting it to `"none"` hides them without affecting Guttered.

- Comparisons use file paths. A renamed file with no matching path in the baseline appears entirely added.
- Ignored files without a baseline are skipped. A file explicitly added to Git, including with `git add -f`, is still compared. Git metadata has no indicators, including the `.git` pointer files used by worktrees and submodules.
- Empty new files have no lines to mark. Deletions use the neighboring line, including when they occur at the beginning or end of a file.
- CRLF/LF differences are normalized; changes to whitespace and the final newline remain visible.
- Baselines must be valid UTF-8 text. Invalid UTF-8, binary files, and baseline symlinks are skipped; Restore is unavailable for these files. Untitled buffers need a file path before their repository can be identified.
- Baselines contain the stored Git blob. Git LFS and other content filters aren't applied, so a filtered file can produce misleading differences against its expanded editor contents.
- Files over the configured size threshold or 50,000 lines are skipped. The diff algorithm has a 100 ms timeout; reading files, splitting lines, and applying decorations occur outside that limit. Diff timeouts are cached until the document, baseline, or configuration changes, or you request a refresh.
- Only file contents are compared. File permissions and deleted files without an open editor have no gutter representation.

## Development

Desktop tests have passed on VS Code 1.95.3 and 1.141.0, including a separate run with built-in Git disabled.

After `npm ci`, press **F5** to launch an Extension Development Host.

```sh
npm run check                 # Strict TypeScript validation
npm test                      # Diff, controller, and real Git repository tests
npm run test:integration       # Desktop extension-host tests; downloads VS Code
GUTTERED_TEST_NO_GIT=1 npm run test:integration   # Tests the fallback with built-in Git disabled
npm run package               # Build the VSIX
```

Desktop tests require a graphical session that can focus the test window. Headless Linux needs Xvfb and a window manager. Set `VSCODE_VERSION` to select a release, for example `VSCODE_VERSION=1.95.3 npm run test:integration`. The tests use temporary repositories and user data and remove them afterward. Prefix environment variables as shown in a POSIX shell; in PowerShell, set them with `$env:NAME = 'value'` before running the command.

The source files follow the work the extension performs: `git.ts` handles Git and its caches, `diff.ts` computes changes and restoration edits, `decorations.ts` draws markers, `hover.ts` previews individual changes, `files.ts` combines saved and unsaved file changes and builds their folder tree, `changedFiles.ts` manages the sidebar, `controller.ts` coordinates updates, `extension.ts` registers commands, and `config.ts` reads settings. The baseline cache is limited to 16 MiB and 256 entries. `diff` is the only runtime dependency and is bundled in the VSIX.

Transparent PNGs are available at 1254×1254 (`assets/logo.png`), 256×256 (`assets/icon.png`), and 128×128 (`assets/icon-128.png`). The VSIX includes only `assets/icon.png`.
