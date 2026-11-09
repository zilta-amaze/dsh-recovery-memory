# Changelog

## 0.1.0 — 2026-11-09

First release.

### Added

- `/recovery create [label]` — snapshot the conversation into one local record and return a
  20-letter recovery code.
- `/recovery memory <code>` — restore that record into another conversation as model-facing context;
  accepts `memory<code>`, a bare code, and `--no-summary` / `-n`.
- Automatic post-restore summary of the recovered session, ending with `记忆已恢复`.
- `/recovery list`, `/recovery delete <code>`, `/recovery where`.
- Configurable record directory: `dir` config, `DSH_RECOVERY_DIR`, `~/` and `$DSH_HOME`-relative
  paths.

### Guarantees

- Records are plain JSON under `$DSH_HOME/recovery`, file mode `0600`, directory `0700`, atomic
  writes.
- No network access anywhere in the plugin; nothing is uploaded.
- The restored transcript is complete unless it exceeds `restoreChars`; a restore never truncates
  the record on disk, and says how many entries were left out when it has to.
- Every restore ends with `记忆已恢复。`.
- Offline test suite: 22 tests, Node 20/22/24 in CI.
