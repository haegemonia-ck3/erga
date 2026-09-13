# Erga

Hegemonia’s Discord teammate for `haegemonia-ck3/Haegemonia_An_Ancient_Odyssey`.

Mention **@Erga** or use **/erga ask** in an allowed channel. Erga opens a Discord thread, checks GitHub, and answers with links. In a thread with exactly Erga and the sender as members, ordinary messages trigger a follow-up. With additional members, mention Erga or reply directly to it; disabling the reply ping is fine. Authorized changes are carried out immediately, with one result in the thread and no confirmation buttons.

## What Erga can do

- Read and filter issues, comments, labels, milestones, branches and repository text files.
- Read PR descriptions, changed files, reviews and CI checks.
- Create and update issues; assign people, labels and milestones; post comments; close and reopen issues.
- Bulk-update up to 50 issues per tool call and batch up to 20 independent reads. Each issue retains its own durable execution record and fresh role check. Writes run sequentially and stop on the first error or cancellation; the report distinguishes applied, failed/unknown, and skipped items. Earlier successful changes are retained.
- Update custom issue fields such as Priority, individually or in bulk, using the field ID and option name. Unrelated custom fields are preserved. Custom-field rows and ordinary issue edits use separate batches.
- Create and update milestones, including descriptions and due dates.
- Create draft or ready PRs between existing branches, edit PRs, request reviews and merge against the reviewed head SHA.
- Permanently delete issues or milestones with the separate delete role.
- Keep conversation/session mappings, change records, tool results and an audit trail in local SQLite.

Erga currently manages GitHub work items; it does not edit code, push branches, manage GitHub Projects boards, or send proactive GitHub notifications. Lists are paginated and the agent is instructed to disclose incomplete coverage.

## Setup

Requires Node.js **24.4+** and credentials for the selected model provider. This is a long-running Discord Gateway process; no public webhook endpoint is needed.

1. Run `npm install`.
2. Copy `.env.example` to `.env.local` **only if `.env.local` does not already exist**. The development configuration in this workspace has already been created; preserve it.
3. Configure the credentials and IDs below.
4. Run `npm run register` to register `/erga` in the configured guild.
5. Run `npm run doctor` for live access checks, then `npm run dev`.

For a compiled run: `npm run build`, then `npm start`. Keep exactly **one Erga process** running against this database and bot token. Run the process through your host’s service manager for continuous operation.

### Discord

Set `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID` and `DISCORD_CHANNEL_IDS` (comma-separated). In the Developer Portal enable **Message Content Intent**. The bot needs View Channel, Send Messages, Read Message History, Create Public Threads, Send Messages in Threads, Attach Files and Embed Links in the allowed channels. Install with the `bot` and `applications.commands` scopes. Administrator is unnecessary.

Threads inherit channel access from their parent. Direct messages are excluded. Erga responds to explicit mentions, direct replies to its own messages within a thread, or `/erga ask`. Ordinary messages also trigger when a fresh Discord member count is exactly two and individual membership checks confirm Erga and the sender. Additional members count even if they have not spoken. If they leave and only the pair remains, automatic replies resume. Membership lookup failures fall back to mentions/replies only. Bot messages and webhooks never trigger it. These rules apply to existing threads too, regardless of session history.

Every triggered request fetches the entire readable thread in pages of 100 messages, oldest first, through the triggering message/command. It includes the original starter message when available, intervening team chat, full message text, reply references, embeds and attachment metadata/links. Attachment binaries are not downloaded automatically. The snapshot is included before the agent starts; the agent does not have to request a history tool first. Later messages are considered on the next explicit request. Discord-deleted messages are unavailable. Failed history reads stop the request rather than silently supplying partial history; there is no application history-count or text-truncation limit, although the model/API input limits still apply to very large threads. Transcript messages provide context, not independent authorization to make changes.

Configure the three role lists when the team is ready:

| Variable | Access |
| --- | --- |
| `DISCORD_READ_ROLE_IDS` | Ask questions and inspect GitHub |
| `DISCORD_WRITE_ROLE_IDS` | Read plus request edits, comments, PRs, merges, stop/reset |
| `DISCORD_DELETE_ROLE_IDS` | Read/write plus permanent issue/milestone deletion |

Use comma-separated Discord role IDs. `everyone` grants a tier to every member who can use the allowed channel. Empty lists grant no access. Roles are fetched again immediately before each mutation. Discord administrators have no implicit bypass. GitHub App permissions remain a separate upper limit.

### GitHub App

Erga supports the existing GitHub App. Set `GITHUB_APP_ID` and `GITHUB_INSTALLATION_ID`, then supply either `GITHUB_PRIVATE_KEY` with the full PEM contents or `GITHUB_PRIVATE_KEY_PATH` with the downloaded PEM’s local path. The contents variable takes precedence when both are set; an empty contents variable falls back to the file. Installation tokens refresh automatically.

For Railway, add `GITHUB_PRIVATE_KEY` as a secret service variable and paste the entire PEM, including its BEGIN/END lines. Actual line breaks and literal `\n` escapes are supported. No PEM file or path is needed on Railway. Keep key files and secret variable values outside source control.

If the installation ID is unknown, configure the App ID, key path and repository first, then run:

```sh
npx tsx --env-file-if-exists=.env.local src/discover-installation.ts
```

This reads the repository installation and saves its ID in `.env.local` without displaying secrets.

Install the App only on intended repositories. Configure repository permissions:

| Permission | Needed for |
| --- | --- |
| Metadata: read | Repository metadata |
| Issues: read/write | Issues, comments, labels, milestones |
| Pull requests: read/write | PRs and review requests |
| Contents: read | Branches and repository files |
| Contents: read/write | Also required to merge PRs |
| Checks: read; Commit statuses: read | CI checks and legacy commit statuses |
| Administration: write | Issue deletion where GitHub requires administrative repository access |

Approve changed permissions on the existing installation. Existing branch protection still applies. Alternatively set `GITHUB_TOKEN` to a fine-grained token; App configuration takes precedence when present. `GITHUB_REPOSITORIES` is enforced in application code on every operation.

### Model providers

Erga uses TanStack AI adapters with an application-owned tool loop. Set `AI_PROVIDER=gemini`, `AI_MODEL=gemini-3.8-flash`, and `GEMINI_API_KEY` for the tested configuration. Gemini thinking is set to LOW. No managed agent session, remote tool bridge, or sandbox is used.

The provider factory also includes `openai` (`OPENAI_API_KEY`) and `anthropic` (`ANTHROPIC_API_KEY`). Set `AI_MODEL` explicitly for either alternative. Only the selected key is required. These adapters are wired but the live migration checks were performed with Gemini; validate another model with `npm run smoke` before selecting it in production. There is no automatic fallback or model substitution.

`npm run doctor` verifies direct model access, GitHub reads and Discord authentication. `npm run smoke` verifies a real tool round-trip with all Erga schemas, a remembered follow-up, and a real open-issue list. Both are read-only with respect to GitHub and Discord, and use model API resources.

Existing threads continue using their full Discord thread snapshot. Old OpenAI session IDs remain in SQLite for historical reference; the new runner never contacts or deletes those sessions. No old user request is replayed. For non-Discord integrations, the runner includes up to ten recent local request records with a 60,000-character history budget, omitting older records whole. It does not implement automatic summarization. Discord's current full snapshot is not truncated by this budget.

### Railway storage

Set `DATABASE_PATH=/data/erga.sqlite` with the service volume mounted at `/data`. If `DATABASE_PATH` is unset, `RAILWAY_VOLUME_MOUNT_PATH` is used when available; local runs default to `data/erga.sqlite`. Before migrating a deployment that used a relative path, back up its live database and copy it to the volume using SQLite's backup API. Do not copy an active SQLite file without its WAL or delete the prior action ledger.

## Operations and recovery

Use `/erga status` to inspect the latest local request and its model, `/erga stop` to cancel work, and `/erga reset` to clear local conversation records after work has stopped. The readable Discord thread is still included on the next request. Stopping or resetting does not undo already applied GitHub changes. After resetting, mention Erga or use `/erga ask` again.

The current user’s explicit request authorizes changes within their role permissions. Erga executes through its GitHub tool and reports the final result once; no preview or approval is required. Historical thread messages are context only. Old approval buttons are retired when clicked and never execute a mutation. Each tool call claims a durable change record atomically; repeated calls return the stored applied result without repeating the write. A lost GitHub response or crash during a write is recorded as **unknown**, and Erga does not automatically repeat that mutation: inspect GitHub before asking for it again.

Discord status edits do not block tool execution. Every complete model response is validated before tools run. Tools execute sequentially, and each result is saved before the next model call. Equivalent mutation calls within a request reuse a durable result even if the model changes the call ID. Arguments, results, credentials and provider reasoning are not printed to logs; timing records separate model steps, local tools and the complete request.

A failed or incomplete stream is not retried automatically. A restart marks unfinished requests as interrupted and unfinished writes as unknown. The next request receives failed-run evidence as context, without replaying its tools. Requests do not resume automatically across restarts. Shutdown cancels active requests and waits for their handlers to settle so completed results can be recorded.

Local request histories are expired hourly after `SESSION_TTL_HOURS` (default seven days). Running requests are retained. Change records, tool results, request deduplication IDs, legacy session references and audit history remain in SQLite. Back up this team-private database safely with SQLite's backup API. Resetting or expiring conversation history does not clear the change ledger.

`TURN_TIMEOUT_SECONDS` defaults to 300. `MAX_ACTIVE_TURNS` defaults to 3. `MAX_MODEL_STEPS` defaults to 20. Each thread runs one request at a time. Answers up to 2,000 characters stay in one message. Longer answers are split into consecutive messages at line/word boundaries, preserving ordinary links and reopening code fences. No answer attachment is added. Multi-issue lists use `###` priority headings based on the GitHub Priority issue field (selected option name), with priority labels as fallback and an Unprioritized category only when no priority is set. Updated instructions apply to existing conversations on their next request. Mentions are suppressed in every bot message.

## Verification

```sh
npm run check
npm test
npm run build
```

Tests use fake service responses, never production GitHub writes. They cover role boundaries, repository scope, mutation payloads, fresh role checks, duplicate calls, crash recovery, App token caching, Discord message limits, local conversation state, provider metadata, cancellation and interrupted responses.

## References

The runner uses [TanStack AI](https://tanstack.com/ai/latest) and its [Gemini adapter](https://tanstack.com/ai/latest/docs/adapters/gemini). Integration details follow [Discord Gateway](https://docs.discord.com/developers/events/gateway), [GitHub App installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app), and [GitHub pull requests](https://docs.github.com/en/rest/pulls/pulls).
