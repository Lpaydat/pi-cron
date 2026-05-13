# pi-cron

Schedule pi prompts to run automatically on a cron schedule against any project directory.

## What it does

- **Define jobs** — each job is a prompt + schedule + project directory
- **Uses project settings** — when a job runs, pi loads the target project's extensions, skills, `.pi/settings.json`, and `AGENTS.md`
- **Delivers results** — via Slack/Discord webhook and/or file output
- **Manages crontab** — `/cron install` writes entries to your system crontab

## Commands

| Command | Description |
|---------|-------------|
| `/cron list` | Show all configured jobs |
| `/cron show` | Show crontab entries for current project |
| `/cron show all` | Show all pi-cron crontab entries, grouped by project |
| `/cron add` | Interactive wizard to create a job |
| `/cron remove <id>` | Delete a job |
| `/cron enable <id>` | Enable a disabled job |
| `/cron disable <id>` | Disable a job without deleting it |
| `/cron run <id>` | Manually trigger a job (test it) |
| `/cron install` | Register enabled jobs with system crontab |
| `/cron uninstall` | Remove all pi-cron entries from crontab |
| `/cron logs [id]` | Show execution logs |

## LLM Tool

The `cron_manage` tool lets the LLM manage jobs directly:

> "Hey pi, schedule a nightly code review at 2am for this project"

The LLM will use `cron_manage` with `action: "add"` to create the job.

## Example Workflow

```bash
# 1. Open pi in your project
cd ~/workspace/my-project
pi

# 2. Add a cron job
/cron add
# → Interactive wizard: name, schedule, prompt, model, webhook, file output

# 3. Test it immediately
/cron run <job-id>

# 4. Register with crontab (so it runs when pi is closed)
/cron install

# Done! The job runs automatically at the scheduled time.
```

## Or via the LLM

```
You: Schedule a daily review of git commits at 2am and post results to Slack

Pi: [uses cron_manage tool to create the job]
    ✅ Created job "Daily commit review" (job-a7b3c9d2)
    Schedule: 0 2 * * * (daily at 02:00)
    CWD: /home/user/workspace/my-project
    Webhook: https://hooks.slack.com/...

    Run /cron install to register with crontab.
```

## Job Configuration

Jobs are stored in `~/.pi/agent/pi-cron.json`:

```json
{
  "version": 1,
  "piPath": "/home/user/.local/share/pnpm/pi",
  "jobs": [
    {
      "id": "job-a7b3c9d2",
      "name": "Daily commit review",
      "schedule": "0 2 * * *",
      "cwd": "/home/user/workspace/my-project",
      "prompt": "Review all commits from the last 24 hours...",
      "model": "anthropic/claude-sonnet-4-20250514",
      "onComplete": {
        "webhook": "https://hooks.slack.com/services/...",
        "writeFile": "/tmp/review-{date}.md"
      },
      "enabled": true,
      "lastRun": "2024-01-15T02:00:00.000Z",
      "lastStatus": "success"
    }
  ]
}
```

## Cron Expression Quick Reference

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-6, 0=Sunday)
│ │ │ │ │
* * * * *    → every minute
0 * * * *    → every hour
0 2 * * *    → daily at 2am
*/15 * * * * → every 15 minutes
0 9 * * 1-5  → weekdays at 9am
0 0 1 * *    → first of every month at midnight
```

## Logs

Execution logs are stored under `~/.pi/agent/pi-cron-logs/<job-id>/`.

## How it works

1. **Extension** (`index.ts`) — loaded by pi, provides `/cron` commands and `cron_manage` tool
2. **Runner** (`runner.mjs`) — standalone Node.js script, invoked by crontab
3. **Config** (`pi-cron.json`) — shared between extension and runner

When a job runs via crontab, the runner:
1. Reads the config
2. Spawns `pi -p` with the job's prompt in the job's cwd
3. Captures output
4. Delivers via webhook/file
5. Saves logs and updates config

The `pi -p` invocation loads all project-local settings (extensions, skills, AGENTS.md, etc.) just like an interactive session.

## Requirements

- Linux (tested on CachyOS / Arch)
- pi coding agent installed globally
- Node.js 18+
- `crontab` available (for /cron install)
