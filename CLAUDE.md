# Website Checker Bot

Telegram bot that monitors website availability. Users add URLs, and the bot checks them every 5 minutes, sending alerts when a site goes down.

## Tech Stack
- **Runtime**: Bun
- **Bot Framework**: Telegraf 4.x
- **Database**: bun:sqlite (built-in, file: `websites.db`)
- **HTTP Client**: Axios
- **Scheduler**: node-cron
- **Config**: dotenv

## Architecture

Single-file app (`index.js`) with:
- **Users table** — tracks Telegram users (id, username, first_name)
- **Websites table** — stores monitored URLs per user with last known status
- **Cron job** — runs every 5 minutes, checks all URLs, notifies user on status change to offline

## Bot Commands
| Command | Description |
|---------|-------------|
| `/start` | Register user, show welcome message |
| `/list` | Show user's monitored sites with status |
| `/delete <url>` | Remove a site from monitoring |
| `/update <old> <new>` | Replace a monitored URL |
| Send any URL | Add it to monitoring |

## Environment Variables
- `BOT_TOKEN` — Telegram bot token (required)
- `ADMIN_ID` — Fallback user ID for notifications (optional)

## Running
```bash
bun install
bun start
```

## Language
- UI messages are in Russian
- Code comments are in Russian
- Maintain Russian localization for all user-facing text

## Notes
- URL validation requires `http://` or `https://` prefix
- Status values: `"online"`, `"offline"`, `"unknown"`
- Notifications only sent on status *change* (not every failed check)
- No `.env` file in repo — must be created locally with `BOT_TOKEN`
