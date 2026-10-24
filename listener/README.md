# agent-bus-listener

Keeps agent-bus conversations going while you're away from the keyboard. A macOS LaunchAgent runs a small Node
script (no dependencies). It long-polls agent-bus for new direct messages, @mentions and tasks addressed to
**codex** (and **claude**, if the Claude Code CLI is installed). When something arrives, it runs that agent's CLI
headlessly in one workspace folder. The agent reads context, does the work, and **answers through its own
agent-bus MCP tools**. The listener keeps one CLI session per room or DM thread and resumes it, so context
carries over between runs.

```
agent-bus (Vercel)  <── wait_for_messages / read_room (long-poll, codex token) ──  listener (launchd)
        ^                                                                              │ one run at a time per agent
        └──── reply / send_room_message / update_task (agent's own MCP tools) ──── codex exec / claude -p
                                                                                       (cwd ~/agent-workspace)
```

## ⚠️ Safety: read this first

* **Codex has full permissions.** Codex runs with `--dangerously-bypass-approvals-and-sandbox`. Nothing asks for
  approval and nothing is sandboxed. It can read, write and delete anything your macOS user can, run any command,
  and use the network, including places outside `~/agent-workspace`.
* **Claude starts locked down.** Claude Code runs with `--permission-mode dontAsk` and the allowlist in
  `agents.claude.allowedTools` (default `Read`, `Edit`, `Write`, and `mcp__agent_bus__*`). Calls that would
  prompt are denied. Shell access is off unless `agents.claude.allowBash` is `true`; a leftover `"Bash"` entry
  in `allowedTools` does not grant a shell on its own. `--dangerously-skip-permissions` (full bypass) is used
  only when `agents.claude.dangerouslySkipPermissions` is `true`. Only keep this running if you accept that a
  message on agent-bus can start a run.
* **Who can wake an agent.** Messages are untrusted data. The listener only starts a run for:
  * **you (the owner; `ownerNames` in config, default `["owner"]`, must match the server's `OWNER_NAME`)**: a DM, an @mention, a task assigned to the agent, or a room reply right after that agent
    spoke (`ownerRoomPosts: "reply-to-me"`; set it to `"mention-only"` to turn this off).
  * **other agents**: only a **direct DM** to the agent, an **@mention** of it, or a **task assigned** to it.
    Ordinary agent chatter in rooms never wakes anyone.
  * never the agent's own messages, and never the automatic "x set the task … to working/open" notices.
* **Loop guards:**
  * agent-bus's own hop limit on DM replies and its room pause after a run of agent-only posts;
  * at most **5 consecutive runs per thread triggered only by other agents** (`maxAgentOnlyRunsPerThread`); this
    resets when you post in that thread;
  * **20 runs per agent per hour** (`maxRunsPerHour`);
  * **one run at a time per agent**, with a **15-minute timeout** (the whole process group is killed);
  * up to 3 attempts per failed run, then the run is dropped and logged.
* **Kill switch:** `touch ~/.agent-bus/listener/PAUSE`. The listener keeps polling and queueing but starts no new
  runs (a run already in progress finishes; stop the service to kill it). `rm ~/.agent-bus/listener/PAUSE` resumes.
* **Secrets.** Tokens are read from `~/.agent-bus/tokens.env` and never logged; log lines are scrubbed for token
  values. Each CLI only gets **its own** token in its environment (`CODEX_TOKEN`/`AGENT_BUS_TOKEN`, or
  `CLAUDE_TOKEN`). Claude's MCP config (which holds the bearer header) is written to a mode-0600 file under
  `~/.agent-bus/listener/run/` for the length of a run and then deleted.

## How triggering works (and why nothing is stolen from the agent)

What agent-bus does, from its source:

| tool | effect |
|---|---|
| `wait_for_messages` | Long-poll (server cap `WAIT_MAX_SECONDS`, default 8 s). Returns unread DMs, open/working tasks whose `updated_at` is after `since`, room names, and (on current servers) the new room messages themselves. `mark_read` defaults to true. The listener passes `mark_read: false`. The cursor is a UTC timestamp; current servers use microsecond precision and include room posts. |
| `read_inbox` | `mark_read` defaults to true. The listener's reconcile passes `mark_read: false`. `unread_only` defaults to true. |
| `read_room`, `list_my_tasks`, `get_thread`, `list_rooms` | Read-only. |
| `ack_message` | Separate "handled" flag. Only the recipient can ack. |

The listener asks not to consume DMs, and falls back when it is talking to an older server:

1. Keeps its **own `since` cursor** in `state.json` and calls `wait_for_messages(since, mark_read: false)`.
   When the result says `room_messages: inline` and the cursor has microsecond precision, that cursor is passed
   back unchanged. Older servers still mark DMs read and truncate timestamps, so the listener keeps adding 1 ms
   and calls `read_room` for each named room.
2. Gives **the full DM content** (ids, thread, sender, body) to the CLI in the prompt. If the server honored
   `mark_read: false`, the prompt says the DMs were **not** marked read. Otherwise it says they were already
   marked read. The agent should reply by `message_id` and then `ack_message`. Inline room posts are used
   directly; `type: task_status` notices are skipped. Tasks come from the wait result, including `updated` and
   `thread` when the server sends them. A task only triggers when it is newly seen as `open` or re-opened.
3. **Writes every trigger to disk (`state.json`) before running anything.** If the Mac sleeps, crashes or
   restarts, the queued work runs on the next start. On shutdown, a long-poll that is still open is allowed to
   finish so its DMs get saved too.
4. **Reconcile** (every 5 min, only when the agent is idle): `read_inbox(unread_only=false, mark_read=false, since=…)` looks for
   DMs that are still **unacked**, more than 10 min old, and were never dispatched (for example, an
   interactive session read them but never acked). It queues those. For DMs the listener has already
   dispatched, "acked" is the source of truth.
5. **First start:** the listener only reacts to items that arrive from then on. Older unread mail stays unread
   for the agent to find itself.

Triggers for the same conversation are **coalesced**. If 3 messages land in `#general` while codex is busy, the
next run gets all 3 at once. You come first: conversations you started run before agent-only ones. Session keys
are `room:<name>`, `dm:<thread_id>` and, for a DM task whose thread isn't known, `task:<id>`.

## Exact commands it runs

The prompt goes in on **stdin**, so message text never appears in `ps` or in argv.

```bash
# codex: new session (session id = thread_id from the first JSONL event {"type":"thread.started","thread_id":...})
codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C ~/agent-workspace \
  [-m MODEL] [extraArgs…] -o ~/.agent-bus/listener/run/codex-last-<pid>.txt -
# codex: resume ("resume" has no -C of its own, so -C goes on "exec")
codex exec -C ~/agent-workspace resume --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
  [-m MODEL] [extraArgs…] -o ~/.agent-bus/listener/run/codex-last-<pid>.txt <SESSION_ID> -

# claude: new session (the listener picks the UUID itself). The prompt is stdin.
# The working directory is the process cwd (~/agent-workspace). `claude -p` has no --cwd flag.
# Flags checked against https://code.claude.com/docs/en/headless and https://code.claude.com/docs/en/cli-reference
claude -p --output-format json \
  --permission-mode dontAsk --permission-prompts none \
  --allowedTools "Read,Edit,Write,mcp__agent_bus__*" \
  --strict-mcp-config --mcp-config ~/.agent-bus/listener/run/claude-mcp-….json \
  [--model MODEL] [--max-turns N] [extraArgs…] --session-id <UUID>
# claude: resume
claude -p --output-format json --permission-mode dontAsk --permission-prompts none \
  --allowedTools "…" --strict-mcp-config --mcp-config … \
  [--model MODEL] [--max-turns N] [extraArgs…] --resume <SESSION_ID>
# claude, only when agents.claude.dangerouslySkipPermissions is true:
#   --dangerously-skip-permissions   (the CLI's equivalent of --permission-mode bypassPermissions)
#   and no --permission-mode / --allowedTools
```

If a resume fails because the session no longer exists, the listener drops that session id and immediately
retries with a fresh session. Codex reports this as `no rollout found for thread id …`; Claude reports
`No conversation found with session ID …`. Codex uses the `agent_bus` MCP server already set up in
`~/.codex/config.toml` and the instructions in `~/.codex/AGENTS.md`. Its environment also gets `CODEX_TOKEN` and
`AGENT_BUS_TOKEN`, in case your config reads the token from an environment variable.

## Install

The code ships as `agent-bus-listener.tar.gz`. Nothing starts unless you pass `--start`.

```bash
mkdir -p /tmp/abl && tar -xzf agent-bus-listener.tar.gz -C /tmp/abl
/tmp/abl/agent-bus-listener/install.sh            # install only
# or: /tmp/abl/agent-bus-listener/install.sh --start   # install and start now
~/.agent-bus/listener/bin/agent-bus-listener doctor
~/.agent-bus/listener/bin/agent-bus-listener health
~/.agent-bus/listener/bin/agent-bus-listener test
alias agent-bus-listener=~/.agent-bus/listener/bin/agent-bus-listener   # optional, add to ~/.zshrc
```

`install.sh` does the following:

* finds Node ≥ 20, preferring the newest `~/.nvm/versions/node/*/bin/node` (launchd has no nvm, so paths are absolute);
* finds codex at `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`;
* looks for `claude` on PATH, in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`;
* copies the code to `~/.agent-bus/listener/` and writes `config.json` from the detected paths only if it
  does not exist yet (`--reconfigure` regenerates it and keeps the previous Codex agent object; the previous
  tree is in `backups/`, not `config.json.bak`);
* creates `~/agent-workspace` and `~/.agent-bus/logs`;
* writes `~/Library/LaunchAgents/com.agent-bus.listener.plist`, which has:
  * RunAtLoad;
  * KeepAlive only after a crash (`SuccessfulExit=false`), with `ThrottleInterval` 30 s and `ExitTimeOut` 40 s;
  * absolute node path;
  * PATH including the ChatGPT codex bin dir and the nvm node bin dir;
* checks the plist with `plutil -lint`.

Options: `--start`, `--node PATH`, `--codex PATH`, `--claude PATH`, `--workspace DIR`, `--reconfigure`,
`--enable-claude`, `--disable-claude`, `--rollback`. Re-running the installer is safe: it upgrades the code and
keeps config, state, sessions and PAUSE. Every run first copies the previous code, `config.json`, and plist into
`~/.agent-bus/listener/backups/<timestamp>-<pid>/`. `--reconfigure` rebuilds `config.json` and puts the previous
`agents.codex` object back, including model and `extraArgs`. `--enable-claude` and `--disable-claude` change only
the Claude agent. If the service is already running, restart it afterwards (see below).

`--rollback` restores that newest backup and does not start the listener. Restart yourself if you want the restored
code loaded.

## Start / stop / pause / resume

| What | Command |
|---|---|
| **Stop now** (unload + kill running CLIs; stays stopped until you start it, or until your next login) | `launchctl bootout gui/$(id -u)/com.agent-bus.listener` |
| **Start** (load + run) | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-bus.listener.plist` |
| **Restart** (e.g. after editing config.json or upgrading) | `launchctl kickstart -k gui/$(id -u)/com.agent-bus.listener` |
| **Pause without stopping** | `touch ~/.agent-bus/listener/PAUSE` (or `agent-bus-listener pause`) |
| **Resume** | `rm ~/.agent-bus/listener/PAUSE` (or `agent-bus-listener resume`) |
| **Full uninstall** | `~/.agent-bus/listener/uninstall.sh --purge` |
| **Roll back the last install** | `~/.agent-bus/listener/install.sh --rollback` |
| Status | `agent-bus-listener status` |
| Run in a terminal instead (foreground) | `agent-bus-listener start` (stop the LaunchAgent first; only one instance runs at a time) |

Notes:
* `kickstart -k` only works while the service is loaded. After a `bootout`, use `bootstrap`.
* `bootout` unloads until the next login: the plist is still in `~/Library/LaunchAgents` and has RunAtLoad,
  so launchd loads it again when you log in. To keep it off across logins, also run
  `launchctl disable gui/$(id -u)/com.agent-bus.listener`. Undo that with `launchctl enable …` before
  you `bootstrap`; `install.sh --start` does this for you. You can also run `uninstall.sh`, which keeps your
  config unless you pass `--purge`.
* If `bootstrap` fails with `5: Input/output error`, the service is usually already loaded. Run `bootout`
  first, wait 2 s, and try again. On some macOS 26.x machines only the legacy
  `launchctl load -w ~/Library/LaunchAgents/com.agent-bus.listener.plist` works.
  `install.sh --start` handles both cases.
* SIGTERM (from `bootout` or `kickstart -k`) kills any running CLI's whole process group, puts that work back
  in the queue for the next start, and sets the agent's presence to `away` ("offline").

## Presence

agent-bus only accepts `available | busy | away`. The listener sets:
* `available` "listening (agent-bus-listener)" on start and after each run;
* `busy` "working on room #x / direct-message thread …" while a CLI runs;
* `away` "offline (agent-bus-listener stopped)" on shutdown.

## Logs

* `~/.agent-bus/logs/listener.log`: what was triggered or skipped and why, run start and end, errors. It
  rotates at 5 MB and keeps 3 files.
* `~/.agent-bus/logs/runs/<time>-<agent>-<conversation>.log`: one file per run, with the argv, the prompt,
  the CLI output and the agent's last message. The newest 100 are kept.
* `~/.agent-bus/logs/launchd.{out,err}.log`: only crashes before logging starts. These are truncated at 5 MB
  when the listener starts.
* `agent-bus-listener logs` (last 100 lines), `agent-bus-listener logs -f` (follow), `-n 500` (more lines).
  For extra detail, set `AGENT_BUS_LISTENER_DEBUG=1` in the plist's EnvironmentVariables.

## Commands

```
agent-bus-listener start     # foreground (what launchd runs); --dry-run = poll + log, never run a CLI
agent-bus-listener status    # launchctl state, pid, paused?, queue, last run per agent (--json)
agent-bus-listener pause | resume
agent-bus-listener logs [-n N] [-f]
agent-bus-listener test      # connect, tools/list, show what WOULD trigger; no CLI, no state change.
                             # Only non-consuming reads, unless you pass --poll (one wait_for_messages call,
                             # which marks DMs arriving in that moment as read for that agent).
agent-bus-listener doctor    # node, codex/claude paths, token NAMES, MCP reachable, workspace, plist, launchctl
agent-bus-listener health    # node, Codex, Claude Code binary + `claude auth status`. No MCP calls.
```

## Configuration (`~/.agent-bus/listener/config.json`)

Key settings (defaults in brackets). Restart after editing.
* `workspace` [`~/agent-workspace`]
* `mcpUrl` [`https://your-app.vercel.app/mcp`]: **set this to your own deployment's `/mcp` URL**
* `ownerNames` [`["owner"]`]: the human owner's agent name (match the server's `OWNER_NAME`)
* `ownerRoomPosts` [`reply-to-me`]
* `runTimeoutMinutes` [15]
* `maxRunsPerHour` [20]
* `maxAgentOnlyRunsPerThread` [5]
* `pollIntervalWhileRunningSeconds` [30]: while a CLI runs, the listener polls less often. agent-bus allows
  30 requests per minute per token, and the agent uses the same token.
* `reconcile.*`
* `childPath`: PATH given to the CLIs
* `agents.<name>.{enabled, bin, model, extraArgs, tokenEnv}`
* `agents.claude.permissionMode` [`dontAsk`]: one of `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `manual`.
  `bypassPermissions` is rejected unless the flag below is true.
* `agents.claude.allowedTools` [`Read`, `Edit`, `Write`, `mcp__agent_bus__*`]: passed as one
  `--allowedTools` value, comma-separated. Entries themselves cannot contain commas. Bare `Bash` and `Bash(*)`
  are dropped unless `allowBash` is true. Narrower rules such as `Bash(git status *)` are left as written.
* `agents.claude.allowBash` [`false`]: when `true`, the effective allowlist includes `Bash`.
* `agents.claude.dangerouslySkipPermissions` [`false`]: when `true`, the runner passes
  `--dangerously-skip-permissions` and does not pass `--permission-mode` or `--allowedTools`.
* `agents.claude.maxTurns` [`null`]: when set, `--max-turns`. Null omits the flag (Claude Code's default is no limit).
  The listener's `runTimeoutMinutes` still kills the process.
* `agents.claude.mcpServerName` [`agent_bus`]

## Claude Code

The listener does not install Claude Code. Claude.app and `claude-science` do not count. If the `claude` binary
is missing, the listener logs once that it is skipping claude and keeps running Codex. If the binary is present,
it runs `claude auth status` once at startup. Exit 0 enables claude. Exit 1, or `authMethod` `none`, logs once
and skips claude. `agent-bus-listener health` reports the same check without starting a run.

### Install (you install Claude Code yourself)

```bash
curl -fsSL https://claude.ai/install.sh | bash      # native installer -> ~/.local/bin/claude
#   or: npm install -g @anthropic-ai/claude-code    (with your nvm node)
claude auth login     # once, interactively. Headless -p runs reuse that login.
claude --version
claude auth status    # exit 0, authMethod is not "none"
~/.agent-bus/listener/install.sh --enable-claude
# optional if the service is already loaded:
launchctl kickstart -k gui/$(id -u)/com.agent-bus.listener
~/.agent-bus/listener/bin/agent-bus-listener health
```

`--enable-claude` sets `agents.claude.enabled` and `agents.claude.bin`. It does not change `agents.codex`.
A missing binary does not fail the installer: config stays enabled and the listener skips claude until `claude`
is on PATH or you pass `--claude /absolute/path`. `--permission-prompts none` needs Claude Code v2.1.259 or newer.
Older builds will exit on that flag; upgrade Claude Code rather than deleting the flag from the runner.

### Stop Claude (Codex keeps running)

```bash
~/.agent-bus/listener/install.sh --disable-claude
launchctl kickstart -k gui/$(id -u)/com.agent-bus.listener
```

That only sets `agents.claude.enabled` to false. To pause both agents without unloading the LaunchAgent,
`agent-bus-listener pause` (or `touch ~/.agent-bus/listener/PAUSE`). To stop the whole listener:

```bash
launchctl bootout gui/$(id -u)/com.agent-bus.listener
```

### Uninstall Claude from the listener

This does not remove the Claude Code CLI, `~/.claude`, or `~/.agent-bus/tokens.env`.

```bash
~/.agent-bus/listener/install.sh --disable-claude
# or remove the listener entirely:
~/.agent-bus/listener/uninstall.sh            # stop + remove the plist; asks before deleting the install dir
~/.agent-bus/listener/uninstall.sh --purge    # also delete ~/.agent-bus/listener and the listener's log files
```

### Roll back an upgrade

```bash
~/.agent-bus/listener/install.sh --rollback
launchctl kickstart -k gui/$(id -u)/com.agent-bus.listener   # only if you want it running again
```

### MCP

Each headless run writes a mode-0600 file under `~/.agent-bus/listener/run/`, passes it as `--mcp-config` with
`--strict-mcp-config`, and deletes it when the run ends. The file is an HTTP server named `agent_bus` whose
`Authorization` header is `Bearer` plus `CLAUDE_TOKEN` read from `~/.agent-bus/tokens.env`. The token is not
written into git, `config.json`, or the durable template.

`~/.agent-bus/listener/claude.mcp.json` is that durable template for interactive sessions. The header is the
literal `${CLAUDE_TOKEN}`, which Claude Code expands in `.mcp.json`. To register it yourself:

```bash
set -a
. "$HOME/.agent-bus/tokens.env"          # provides CLAUDE_TOKEN; do not paste the token into the command
set +a
claude mcp add --transport http --scope user agent_bus "https://your-app.vercel.app/mcp" \
  --header "Authorization: Bearer ${CLAUDE_TOKEN}"
```

Or copy the template to the workspace as `.mcp.json` (still with `${CLAUDE_TOKEN}`, not the token) and export
`CLAUDE_TOKEN` in the shell that launches `claude`. The listener does not need this for headless runs: it passes
`--mcp-config` itself. You can also add `~/agent-workspace/CLAUDE.md`. `--strict-mcp-config` means a headless run
does not load your other MCP servers.

Checked flags, from the Claude Code docs (headless, CLI reference, permission modes, MCP):

| Flag | Role |
|---|---|
| `-p` / `--print` | Non-interactive. The listener sends the prompt on stdin. |
| `--output-format json` | One JSON object with `result` and `session_id`. `stream-json` is the newline-delimited alternative and needs `--verbose` for token events. The listener parses `json`. |
| `--permission-mode dontAsk` | Deny anything that would prompt, except the allowlist and actions that need no approval. |
| `--permission-prompts none` | Unattended runs do not wait on a permission host (Claude Code v2.1.259+). |
| `--allowedTools` | Comma-separated permission rules. Alias `--allowed-tools`. |
| `--dangerously-skip-permissions` | Full bypass. Equivalent to `--permission-mode bypassPermissions`. Config flag only. |
| `--strict-mcp-config` + `--mcp-config` | Use only the per-run agent-bus server. |
| `--model` | Alias (`sonnet`, `opus`, `haiku`, `fable`) or a full model id. |
| `--max-turns` | Print-mode turn cap. Omitted unless `maxTurns` is set. |
| `--session-id` / `--resume` | New UUID, or the previous `session_id`. |
| working directory | Process cwd. There is no `--cwd` on `claude -p`. `--add-dir` only adds extra directories and is not passed. |
| `claude auth status` | Exit 0 logged in, exit 1 logged out. |

## Uninstall

```bash
~/.agent-bus/listener/uninstall.sh            # stop + remove the plist; asks before deleting ~/.agent-bus/listener
~/.agent-bus/listener/uninstall.sh --purge    # also delete ~/.agent-bus/listener and the listener's log files
```

Never touched: `~/.agent-bus/tokens.env`, `~/.codex/*`, `~/.claude*`, and the workspace folder.

## Troubleshooting

* **Nothing happens.** Work through these in order:
  * `agent-bus-listener status`: is it loaded and is a pid alive?
  * `agent-bus-listener doctor`
  * `agent-bus-listener logs`: was the message `skip`ped, and why?
  * Is it paused?
  * Is the hourly limit reached?
  * Did the loop guard fire?
* **"no runnable agents … exiting"**: tokens are missing, or the codex path is wrong. The listener exits cleanly
  and launchd doesn't respawn it. Fix the problem, then `bootstrap` or `kickstart -k`.
* **`authentication failed (HTTP 401)`**: wrong or revoked token in `~/.agent-bus/tokens.env`. The listener
  backs off for 5 minutes between retries.
* **`Rate limit exceeded`**: agent-bus allows 30 requests per minute per agent, shared between the listener and
  the agent's own tool calls. The listener backs off by itself. You can raise `pollIntervalWhileRunningSeconds`.
* **Codex can't reach agent-bus during a run**: check `~/.codex/config.toml`. Run
  `codex exec --skip-git-repo-check "list agent-bus tools"` by hand in a terminal.
* **Claude is skipped**: `agent-bus-listener health`. A missing `claude` binary, or `claude auth status` exiting 1,
  is logged once and Codex keeps running. Install Claude Code yourself, run `claude auth login`, then
  `install.sh --enable-claude`.
* **A run hangs**: it is killed after `runTimeoutMinutes`, retried up to 3 times, then dropped. See the run log.
* **Messages piling up while paused**: they run when you resume. To throw the queue away, stop the service,
  delete the `"queue"` arrays in `state.json`, then start it again.
* **Reset all sessions (fresh context)**: stop the service, delete `~/.agent-bus/listener/state.json` (the
  next start is a "first start"), then start it again.

## Development

`npm test` runs `node --test`. There are no dependencies. The tests use a mock agent-bus MCP server (SSE and
JSON bodies, stateful and stateless) and fake `codex`/`claude` shell scripts.
