# 🌳 Browser History Tree

Track your browser navigation as an **interactive tree**, visualize the paths you took between websites, and export a summary for use with AI tools.

## Architecture

```
┌─────────────────────┐     HTTP POST      ┌─────────────────────────┐
│  Chrome Extension   │ ────────────────→  │  Service (Node.js)      │
│  (background.js)    │                    │  Express + SQLite        │
│  Tracks navigations │ ←── title updates  │  localhost:7890          │
└─────────────────────┘                    └────────────┬────────────┘
                                                        │
                                          ┌─────────────┼─────────────┐
                                          │             │             │
                                     REST API      Web UI        CLI
                                    /api/…        /             browse-tree
```

## Quick Start

### 1. Install the service

```bash
cd service
npm install
npm start          # starts the service on http://localhost:7890
```

Or install the CLI globally:

```bash
cd service
npm install -g .
browse-tree serve   # start the service
```

### 2. Install the Chrome extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `extension/` folder
4. The 🌳 icon will appear in your toolbar

### 3. Browse!

Start browsing — the extension will automatically record every navigation and send it to the service. Open the web UI at [http://localhost:7890](http://localhost:7890) to see your history tree.

---

## CLI Reference

```bash
browse-tree serve           # Start the web service (default port 7890)
browse-tree sessions        # List all browsing sessions
browse-tree list            # List recent navigation events
browse-tree list --session latest
browse-tree tree            # Print ASCII navigation tree for latest session
browse-tree tree --session <id>
browse-tree stats           # Show top domains visited
browse-tree export          # Export as Markdown (AI-ready)
browse-tree export --format json --output history.json
browse-tree export --format csv  --output history.csv
browse-tree summary         # Print AI-ready Markdown summary to stdout
```

All commands accept `--db <path>` to specify a custom database file (default: `~/.browser-history-tree/history.db`).

---

## Service API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/events` | Record a navigation event |
| `PATCH` | `/api/events/:id` | Update event title |
| `GET` | `/api/events` | List events (`?session=`, `?limit=`, `?url=`) |
| `GET` | `/api/tree` | Get navigation tree (`?session=`) |
| `GET` | `/api/sessions` | List sessions |
| `GET` | `/api/stats` | Domain visit counts (`?session=`) |
| `GET` | `/api/export` | Export data (`?format=json\|csv\|markdown`, `?session=`) |

---

## Web UI Features

- **🌳 Tree view** — D3.js hierarchical tree showing your navigation paths
- **📅 Timeline view** — Chronological list with nesting showing origin
- **🔍 Search** — Filter nodes by URL or title
- **📋 Export** — Copy Markdown summary to clipboard (paste into any AI chat), or download JSON/CSV
- **📊 Domain stats** — Bar chart of most visited domains
- Auto-refreshes every 30 seconds while the service is running

---

## Data Model

```
sessions
  id, started_at, ended_at, label

events
  id, session_id, url, title, timestamp,
  tab_id, parent_event_id, transition_type, transition_qualifiers
```

A new **session** is automatically created when the browser has been idle for more than 30 minutes.

Each **event** links to a `parent_event_id`:
- `null` → you typed the URL or opened a bookmark (new navigation root)
- set → you clicked a link or opened a tab from another page

---

## AI Export Format

`browse-tree export` (or the **📋 Markdown** button in the web UI) produces a document like:

```markdown
# Browser History Summary

## Session: Jan 15, 2024 09:30 — 10:15 (45 min)

### Navigation Paths

**Path 1** *(typed — 9:30:00 AM)*
google.com — 9:30:00 AM
  ↳ github.com — 9:30:15 AM
      ↳ github.com/user/repo — 9:30:45 AM
          ↳ github.com/user/repo/issues — 9:31:10 AM

### Top Domains

- **github.com**: 8 visits
- **google.com**: 3 visits
```

Paste this into any AI assistant to get a summary of your research session.

---

## Development

```bash
# Run tests
cd service && npm test

# Service watches for changes
cd service && node bin/browse-tree.js serve
```

The extension does not require a build step — load the `extension/` directory directly.

---

## Privacy

All data is stored **locally** in `~/.browser-history-tree/history.db`. Nothing is sent to any third-party service. The Chrome extension only communicates with `localhost:7890`.