# Erga

Hegemonia’s Discord teammate for `haegemonia-ck3/Haegemonia_An_Ancient_Odyssey`.

Mention **@Erga** or use **/erga ask** in an allowed channel. Erga opens a Discord thread, checks GitHub, and answers with links. In a thread with exactly Erga and the sender as members, ordinary messages trigger a follow-up. With additional members, mention Erga or reply directly to it; disabling the reply ping is fine. Authorized changes are carried out immediately, with one result in the thread and no confirmation buttons.

## What Erga can do

- Read and filter issues, comments, labels, milestones, branches and repository text files.
- Read PR descriptions, changed files, reviews and CI checks.
- Create and update issues; assign people, labels and milestones; post comments; close and reopen issues.
- Create and update milestones, including descriptions and due dates.
- Create draft or ready PRs between existing branches, edit PRs, request reviews and merge against the reviewed head SHA.
- Permanently delete issues or milestones with the separate delete role.
- Keep conversation/session mappings, change records, tool results and an audit trail in local SQLite.

Erga currently manages GitHub work items; it does not edit code, push branches, manage GitHub Projects boards, or send proactive GitHub notifications. Lists are paginated and the agent is instructed to disclose incomplete coverage.

## Setup

Requires Node.js **24.4+** and an OpenAI project with Agents API access. This is a long-running Discord Gateway process; no public webhook endpoint is needed.

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

### OpenAI

Set `OPENAI_API_KEY` and optionally `OPENAI_MODEL` (default `gpt-5.6-luna`). Reasoning and verbosity are explicitly set to `low`; reasoning summaries are disabled (`summary: null`). The project needs `api.agents.read`, `api.agents.write` and `api.responses.write`. Each thread uses an Agents API session without a sandbox. GitHub and Discord tools run in Erga’s application process; no shell or workspace is provisioned. Discord and GitHub credentials are never passed to the model or sandbox. After a model/settings change or migration from a hosted sandbox, existing threads move to a new session on their next request, carrying up to 30,000 characters of recent conversation; previous sessions remain available until normal expiry cleanup.

`npm run smoke` checks Erga’s function tools and persistent follow-ups without a sandbox. `npm run doctor -- --openai-only` optionally checks hosted sandbox access without Discord or GitHub configuration. It runs a small sandbox operation and deletes the temporary session. These live checks use API resources.

## Operations and recovery

Use `/erga status` to inspect the session and last turn, `/erga stop` to cancel work, and `/erga reset` to delete the session context after work has stopped. Stopping or resetting does not undo already applied GitHub changes. After resetting, mention Erga or use `/erga ask` again.

The current user’s explicit request authorizes changes within their role permissions. Erga executes through its GitHub tool and reports the final result once; no preview or approval is required. Historical thread messages are context only. Old approval buttons are retired when clicked and never execute a mutation. Each tool call claims a durable change record atomically; repeated calls return the stored applied result without repeating the write. A lost GitHub response or crash during a write is recorded as **unknown**, and Erga does not automatically repeat that mutation: inspect GitHub before asking for it again.

Discord status edits do not block tool execution. Results from multiple pending tool calls are submitted together, while mutations still execute sequentially. Console timing records distinguish local tool execution from submission to OpenAI; arguments, outputs and credentials are not logged.

Streams reconnect before retrieving saved state and tool results. User input is never blindly replayed. If the process exits during a turn, use `/erga status`, then stop/reset as appropriate. Session IDs and turn IDs are retained in `data/erga.sqlite`. The current version does not resume active tool responders automatically across a process restart.

Inactive idle/failed sessions are deleted hourly after `SESSION_TTL_HOURS` (default seven days). Active sessions are not automatically deleted. The local database retains change records (in the legacy proposals table) and audit history; treat it as team-private data and back it up with its SQLite WAL safely. Do not delete it while Erga is running. Retention is configurable for hosted sessions only.

`TURN_TIMEOUT_SECONDS` defaults to 300. `MAX_ACTIVE_TURNS` defaults to 3. Each thread runs one request at a time. Answers up to 2,000 characters stay in one message. Longer answers are split into consecutive messages at line/word boundaries, preserving ordinary links and reopening code fences. No answer attachment is added. Multi-issue lists use `###` priority headings based on the GitHub Priority issue field (selected option name), with priority labels as fallback and an Unprioritized category only when no priority is set. Updated instructions apply to existing conversations on their next request. Mentions are suppressed in every bot message.

## Verification

```sh
npm run check
npm test
npm run build
```

Tests use fake service responses, never production GitHub writes. They cover role boundaries, repository scope, exact mutation payloads, direct execution, fresh role checks, duplicate calls, retired approval buttons, crash recovery, App token caching, Discord message limits, session reuse, tool results, failures and stream reconciliation.

## References

Adapted from [OpenAI’s Slack teammate showcase](https://developers.openai.com/showcase/agents-api-slack-bot), using the current [Agents API](https://developers.openai.com/api/docs/guides/agents-api/quickstart) and [application function tools](https://developers.openai.com/api/docs/guides/agents-api/tools/functions). Integration details follow [Discord Gateway](https://docs.discord.com/developers/events/gateway), [GitHub App installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app), and [GitHub pull requests](https://docs.github.com/en/rest/pulls/pulls).
