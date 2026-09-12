# Command Code IDE Diff Gate

Show Command Code's edits in a **native VS Code diff** — syntax-highlighted, theme-colored — the way
Claude Code does it. In `default` mode the diff appears **the moment the permission prompt appears**,
so you can read what is about to change while you decide, and veto it from the IDE. Every other mode
is untouched.

Two pieces:

| Piece | Runs in | Role |
| --- | --- | --- |
| `mod/ide-diff-gate.ts` | the `cmd` process | simulates the edit, opens the diff before the prompt, blocks on veto, gates the edits it cannot simulate |
| `extension/` | VS Code | the diff surface: `vscode.diff` plus the Reject/Accept buttons over a local socket |

```
model → edit_file(src/auth.ts)
  → tool_queued                    (fires BEFORE the permission check)
       ├─ the TUI prompt appears   "Do you want to make this edit?"
       └─ the preview tab opens    read-only, [✗ Reject], focus stays in the terminal
  → you read the colored diff, then answer the prompt
       ├─ Reject clicked → the tool is blocked, the file is never touched
       └─ Yes            → the edit lands, the tab closes, nothing more is asked
```

Why the diff can appear that early: `tool_queued` is the only agent event that fires **before** the
permission phase. It cannot block, so the preview is read-only — but it can open a tab and keep a
socket, and the Reject button answers on that socket. `beforeToolCall` (which runs after the prompt
is answered) turns a recorded veto into a real block.

**Fallback, on purpose:** when the edit cannot be simulated (see the table below) there is no
preview, so the older post-write Accept/Reject gate runs for that call instead. Review coverage is
never lost, only moved.

## Install

```bash
./install.sh
# then: reload the VS Code window, and run /reload inside cmd
/ide-diff status     # shows enabled, live mode, bridge path, previews, vetoes, gates
```

Cursor/Windsurf: `VSCODE_EXT_DIR=~/.cursor/extensions ./install.sh`.
Uninstall: `rm -rf ~/.vscode/extensions/wiszel.ide-diff-0.0.1 ~/.commandcode/mods/ide-diff-gate.ts`.

Options come from mod flags:

```bash
cmd --mod-option ide-diff=false              # start with the gate off
cmd --mod-option ide-diff-timeout=5          # seconds to wait for a post-write gate answer (default 300)
cmd --mod-option ide-diff-pin=default        # pin the gate to a mode, ignoring live detection
```

The gate window is the mod's call: the extension clears its own idle timeout while a gate is
waiting, so a human gets the full `ide-diff-timeout` rather than being cut off by the socket.

Flags are read **on first use, not in the factory** — `cmd.getFlag` is a live method and returns
`undefined` before the harness binds, which silently discards `--mod-option`. If you add a flag,
apply it in `applyFlags()`, never at factory time.

Mid-session: `/ide-diff on|off|pin <mode>|status`. `pin` is the escape hatch when the tracked mode
disagrees with the TUI (and the only way to exercise the gate in print mode, where `--yolo` forces
bypass); `pin none` clears it.

## Mode policy

| Mode | Behavior |
| --- | --- |
| `default` | preview at prompt time + Reject veto; a previewed edit is **not** asked about again |
| `auto-accept`, `bypass`, `dont-ask`, `plan` | nothing — no tab, no preview, no gate |

The mode is tracked **live**: the initial value comes from the CLI flags (`--yolo`,
`--auto-accept`, `--plan`, `--permission-mode`) or `permissions.defaultMode` in
`~/.commandcode/config.json`, and every change is picked up from the `permission_mode_changed`
event — shift+tab, `/mode`, `/plan`, and the TUI's "allow all edits this session" all flip it.

`/ide-diff on|off|pin <mode>|status` toggles or inspects it mid-session.

The hook state carries no mode — probed, not assumed: a mod sees
`{sessionId, messages, interrupted, modState}` and nothing else, so the event stream plus the
initial flag/config read is the whole mechanism. (If a future harness adds `state.permissionMode`,
prefer it — the mod tracks the mode in one closure variable, so it is a two-line change.)

## What can be previewed

The preview has to reproduce the edit *before* the tool runs, so it is only opened when the edit is
reproducible exactly:

| Call | Preview |
| --- | --- |
| `write_file` (new or existing) | always — `content` is given verbatim |
| `edit_file`, `old_string` found exactly | yes |
| `edit_file`, `old_string === ''` (create) | yes — the projection is `new_string` |
| `edit_file`, several matches without `replace_all` | no — the tool refuses it anyway |
| `edit_file`, a fuzzy match is needed (whitespace, indentation, punctuation, block anchor) | no — the post-write gate covers it |
| file >10 MB, binary (NUL byte), or unreadable | no |

The harness's match cascade cannot be faithfully replayed, so those edits fall back rather than show
a preview that might be wrong.

## How the bridge works

Discovery mirrors the vendor extension's design, so it feels native:

```
~/.commandcode/ide-diff/
  code-a1b2c3d4.json    { socketPath, workspaceFolders, pid, ideName, timestamp }   (0600)
  code-a1b2c3d4.sock    Unix socket                                                (0600)
```

- Directory is `0700`; on Windows `socketPath` is `\\.\pipe\commandcode-ide-diff-<shortId>` and no
  socket file exists.
- `ideName` is `code` / `cursor` / `windsurf`, from `vscode.env.appName`.
- The mod scans the directory and matches `workspaceFolders` against its cwd (deepest match wins).
  Only the "nothing found" answer is cached (5 s) — a positive hit is re-scanned, so restarting the
  IDE mid-session is picked up on the next gate. `CC_IDE_DIFF_DIR` overrides the directory (the
  tests use it to stay out of a live session's way).

Protocol — newline-delimited JSON, one request per connection:

```jsonc
// mod → extension — the prompt-time preview (a socket kept open for the veto)
{"type":"request","id":"<uuid>","payload":{
  "action":"openPreview","requestId":"<uuid>","filePath":"/abs/path/src/auth.ts",
  "oldContent":"<current content>","newContent":"<simulated result>","tabName":"auth.ts  —  preview"}}
{"type":"response","id":"<uuid>","payload":{"result":"preview"}}      // immediate
{"type":"response","id":"<uuid>","payload":{"result":"reject","reason":"veto"}}   // when Reject is clicked
// A preview is never superseded: another edit to the same file simply opens its own tab, numbered
// `#2`, `#3`… once that file has more than one live. `reject:superseded` below is a GATE reason.

// mod → extension — the post-write gate, for edits that could not be simulated
{"type":"request","id":"<uuid>","payload":{
  "action":"openDiff","requestId":"<uuid>","filePath":"/abs/path/src/auth.ts",
  "oldContent":"<pre-edit content, or null if the file did not exist>","tabName":"auth.ts  —  accept or reject"}}
{"type":"response","id":"<uuid>","payload":{"result":"accept"}}
{"type":"response","id":"<uuid>","payload":{"result":"reject","reason":"closed"}}
```

Gate `reason` is one of `button`, `closed`, `disconnected`, `reload`, `superseded`. `action:"ping"`
returns `{result:"pong"}` — handy for checking the bridge by hand.

Rendering uses two in-memory schemes: a preview puts the current content on `cc-diff:` and the
projection on `cc-diff-new:` (both virtual — the file has not changed yet), while the gate puts the
pre-edit snapshot on `cc-diff:` and the **real file** on the right, so it stays truthful and
editable. `vscode.diff` gives the native editor. Title-bar buttons are driven by `setContext`
(`ccDiffGateActive` = gate, `ccDiffVetoActive` = preview), recomputed whenever the active tab
changes.

Tab lifetime is the socket's: the mod closes the preview socket when the tool result arrives (and on
denial, interrupt, or run end), and the extension closes the tab on the disconnect. Closing the tab
by hand only cancels the review — it never vetoes. Tabs are strictly per edit: nothing one edit does
disturbs another edit's tab, and a gate for a file that already has a pending preview opens next to
it instead of replacing it.

## Debugging a gate that does not open

Every decision point writes to `~/.commandcode/ide-diff/gate.log` (rotated at 1 MB):

```bash
tail -f ~/.commandcode/ide-diff/gate.log
```

A healthy run reads like this:

```
factory cwd=/repo argv=[...] mode=default enabled=true timeout=300000
flags applied enabled=true timeoutMs=300000 mode=default pinned=true
queued edit_file /repo/src/auth.ts
preview opened for /repo/src/auth.ts (call_abc123)
before edit_file /repo/src/auth.ts: snapshot exists=true
after edit_file /repo/src/auth.ts: previewed at prompt time → no second ask
```

`preview opened` lands **before** `before edit_file` — that gap is the whole point: the diff is on
screen while the prompt is still waiting.

A bail names itself — `preview … : not projectable, the post-write gate covers it`,
`skipped (enabled=… mode=…)`, `no snapshot (beforeToolCall did not run)`,
`gate: no bridge found`, `preview veto recorded for …`, `before … : BLOCKED by IDE veto`,
`previews closed (denied|interrupted|run_end)`.

`/ide-diff status` reports the same live state in one line: enabled, mode (+ pinned), bridge path,
previews (and how many were vetoed), and gates opened.

Four things learned the hard way, all now fixed:

- **`cmd.getFlag` is undefined at factory time.** Reading flags there discards `--mod-option`
  silently. Apply them lazily.
- **Sub-agent tool calls never reach mod hooks.** Verified: a `general` sub-agent's `write_file`
  created the file with no `beforeToolCall`/`afterToolCall` at all, while `subagent_start`/`stop`
  fired normally. The harness isolates them, so there is nothing to guard and no sub-agent counter
  in the mod.
- **Never invalidate a preview.** Two edits to one file in one batch could stall the agent: the
  extension superseded the older preview by `destroy()`ing its socket, so that `openPreview` — still
  awaiting `vscode.diff` — never delivered its ACK. The mod read the dead socket as "nothing was
  reviewed" and opened a blocking post-write gate for an edit the user had already approved in the
  terminal, up to the full `ide-diff-timeout` of waiting, and a reject restored the snapshot and
  wiped the edit. The same supersede also answered a pending preview with `reject:superseded`, which
  a preview reports back as a veto — a fabricated verdict that could block an approved edit the
  moment its prompt was answered. Previews are per edit now and nothing supersedes, drops or votes
  on a sibling.
- **`snapshots` was keyed by file path, not by call.** The surviving post-write gate in a same-file
  batch reverted against a sibling call's snapshot, and the sibling found none and skipped review
  entirely. Keyed by tool call now, so each gate restores the content its own call started from.

## Failure policy

- **Infrastructure** (no extension, no socket, extension killed) → **fail open**: the edit applies,
  with a one-time notice in the feed. A dropped preview socket is never read as a veto.
- **User decision** → **fail closed**: the post-write gate treats a closed tab, a killed VS Code, a
  socket drop, a window reload, or the timeout as reject and restores the snapshot.
- **Stray tab close** → cancels that preview only; the write is not affected.
- **Supersede** → gates only: a newer gate request for the same file answers an older unanswered gate
  (`reject:superseded`). A preview is never superseded, dropped or voted on by a sibling — every edit
  keeps its own tab, socket and verdict until its own call resolves.

## Known limits

1. **The preview needs the prompt to actually wait.** Approval can beat the socket round trip
   (~25 ms): a session-wide "allow all edits", an `allow` rule, or a print-mode run resolves the
   tool before the tab can open. The mod detects this — the late preview is closed rather than
   shown, `too late` appears in `/ide-diff status`, and the post-write gate covers that edit
   instead. Interactively, a human always beats 25 ms.
2. **`ide-diff-pin` is a diagnostic, not a CI setting.** It forces the gate on regardless of mode,
   so a pinned *headless* run has nobody to answer: the gate times out and reverts the edit.
3. **The veto has a race window.** Clicking Reject after the prompt is already answered is ignored —
   the write is landing. The window is milliseconds, and the failure mode is "the edit applied
   anyway", never data loss.
4. **Previews need a reproducible edit** — see the table above. Everything else falls back to the
   post-write gate, which is the older review-after-write flow.
5. **Post-write gating (fallback only)** — the edit is briefly on disk before that diff opens, so
   file watchers and `git status` can observe it, and a crash in between leaves the edit applied.
6. **Revert granularity (fallback only)** — the snapshot is the file at `beforeToolCall` time;
   changes made outside the agent after that are lost on reject.
7. **The gate's right pane is the real file**, so edits made there persist on Accept — Accept means
   "keep what is on disk now".
8. **The preview tab is read-only** (both sides virtual); edits typed into it cannot be saved.
9. **N edits to one file in one batch** — one tab per edit, all live at once, each with its own
   Reject, numbered when a file has more than one (`auth.ts — preview`, `auth.ts — preview #2`).
   A newer request never invalidates an older tab. Each projection is computed at queue time against
   the same pre-batch content, so a dependent edit (its `old_string` created by an earlier edit in
   the same batch) cannot be projected and falls back to the post-write gate for that call.
10. **Windows pipe has no auth token** (same as the vendor extension) — any local process can connect
    to the pipe name. Local-only; never a network service.
11. **Sub-agent edits never reach mods** — the harness isolates them, verified. A sub-agent's write is
    neither previewed nor gated.
12. **Windows is untested** (built on Linux). The code path is guarded (`process.platform !== 'win32'`
    for `chmod`/`unlink`, pipe name instead of socket file) but re-run the checks below on a Windows
    box or via WSL + VS Code Remote (which uses the Unix path).

## Verification

Two runnable checks ship with this repo — both are self-contained (no VS Code, no network):

```bash
node test/e2e.mjs        # the mod, against a fake bridge in its own temp dir: preview at queue
                         # time with the projected content, veto blocks the tool, a previewed edit
                         # skips the gate AND closes its socket, a fuzzy edit falls back to the
                         # gate, two edits to one file in one batch gate against their own
                         # snapshots, a binary gets no preview, an unreadable file is never gated or
                         # deleted, rejecting a new file removes it, auto-accept previews nothing,
                         # a dead bridge fails OPEN, and nothing is left in the real bridge dir
node test/extension.cjs  # the extension with a stubbed `vscode` and a stubbed homedir:
                         # preview ack + veto context + drop→tab closes, two same-file previews that
                         # each keep their own tab, socket and Reject, a gate that opens next to a
                         # pending preview without voting on it, gate accept and close→reject, ping,
                         # cleanup
node --check extension/extension.js
```

> Both checks stay out of a live editor session: `e2e.mjs` redirects discovery with
> `CC_IDE_DIFF_DIR` and `extension.cjs` points `os.homedir()` at a throwaway dir. Keep it that
> way — cleaning `code-*.json` in the real bridge dir unregisters a running editor's bridge, and
> only a window reload restores it. Both suites must also **exit on their own**: a leaked socket
> (say, a preview the mod forgot to close) makes node hang, which is a real bug surfacing.

End-to-end in a real editor (the part a test cannot cover):

1. `./install.sh`, reload the VS Code window (`Developer: Reload Window`), then `/reload` in cmd.
2. `ls -l ~/.commandcode/ide-diff/` → `code-*.json` at `0600`, dir `0700`; the "Command Code Diff
   Gate" output channel logs `server started`.
3. `/ide-diff status` → `bridge: /home/.../code-xxxxxxxx.sock`.
4. In `default` mode, ask for a one-line edit to a scratch file: the prompt appears **and** the
   preview tab opens at the same moment, colored, terminal keeps focus, `[✗ Reject]` in the title
   bar. Answer Yes → the edit lands, the tab closes by itself, nothing else is asked.
5. Ask again → click **Reject**, then answer Yes → the model is told the edit was rejected, the file
   is untouched (`git diff` empty).
6. Ask for **two edits to the same file in one message** → two preview tabs (`file — preview`,
   `file — preview #2`), both live while both prompts are open; Reject on the active tab vetoes only
   that edit. Answer both prompts Yes → each tab closes with its own call, no Accept/Reject tab
   appears afterwards and the agent carries on. `tail ~/.commandcode/ide-diff/gate.log` shows no
   `bridge unreachable` and no `gate: opening` for that file — just `preview opened …` lines and
   `after edit_file …: previewed at prompt time → no second ask`.
7. Ask for an edit that needs fuzzy matching → no preview, and the post-write Accept/Reject gate runs.
8. shift+tab to `auto-accept` → edits land with no tab at all; `/ide-diff status` reports the mode.
9. Failure modes: a dead bridge (`mv` the session file) → no preview, edit applies, one notice.

Cross-platform note: only the Linux/macOS paths are exercised here. Windows is code-reviewed, not
run — re-run steps 2–9 on Windows (or via WSL + VS Code Remote, which uses the Unix path).
