# Changelog

## 0.7.0

- First release of the optional desktop companion for Guttered’s experimental glyph clicks in WSL, SSH, and container workspaces.
- Install and restore the workbench hook in the local desktop client while comparisons stay in the remote extension host. Route clicked URI objects through VS Code, and reject stale sessions or mismatched payloads.
- Open the diff mode selected in Guttered: the native diff editor or experimental inline Quick Diff. Preserve breakpoint and context-menu actions.
- Keep the feature disabled by default, exclude its client setting from Settings Sync, and provide verified recovery artifacts. Require explicit re-enabling after application updates and restore before uninstalling.
