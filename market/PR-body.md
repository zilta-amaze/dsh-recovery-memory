# Add dsh-recovery-memory

Conversation memory for dsh, keyed by a 20-letter recovery code.

## What it does

- `/recovery create [label]` snapshots the current conversation into one local record and prints a
  20-letter code (`ABCDE-FGHJK-LMNPQ-RSTUV`). Input is case- and separator-insensitive; the alphabet
  omits `I`/`O` so a code can be read aloud or typed on a phone.
- `/recovery memory <code>` injects that record into the current conversation as model-facing context,
  then asks the model to summarise the recovered session and to end its reply with `记忆已恢复`.
  `--no-summary` restores without the summary.
- `/recovery list`, `/recovery delete <code>`, `/recovery where` manage the stored records.
- Nothing leaves the machine: records are plain JSON under `$DSH_HOME/recovery` (file `0600`, directory
  `0700`), written atomically, and there are no network calls anywhere in the plugin.

## Fidelity

The stored transcript keeps every user/assistant/tool message — no per-message summarising — and the
restore replays it in full whenever it fits the configured budget (`restoreChars`, default 48000
characters). Only a larger conversation falls back to head + tail, and the dropped middle stays in the
record on disk; the injected block says how many entries were left out. The block always ends with
`记忆已恢复。`.

## Moving the data

`dir` (plugin config) or `DSH_RECOVERY_DIR` (environment) relocates the directory — e.g. to shared
storage or a synced folder. `~/` expands to the OS home and a relative path resolves against
`$DSH_HOME`. `/recovery where` reports the current directory, where it came from, whether it is
writable, and how many records it holds.

## How it is built

`package.json` declares `dsh.bundle` (patch at `cordis.patch.yml`, mounted as one row) and nothing
else: no `dsh.client`, no dependencies, no build step. `index.js` registers one slot in the `commands`
service and uses Node built-ins only — deliberately, so a linked checkout loads without resolving any
`@deepseek-ai/*` package. `lib/` holds code generation, the atomic record store, and the
transcript/digest rendering.

## Checklist

- [x] `dsh.bundle` patch + `cordis.patch.yml` at the repo root
- [x] Real, working Host code; no dependencies, no build step
- [x] README with install, usage, configuration and the memory-path recipe; MIT licence
- [x] `dsh-plugin` topic added to the repository
- [x] Offline test suite (22 tests, Node 20/22/24 in CI)
- [ ] Repository is at least 1 day old (CI checks this)
