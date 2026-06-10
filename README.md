# context-index-mcp

A lightweight context index MCP server for AI agents. No external services, no embeddings, no API keys — just a JSON file and a scoring function.

**Author:** Marcus Low Wern Chien (marcuslowwernchien@gmail.com)

---

## What Is This?

When you build an AI agent (like a personal butler, coding assistant, or workflow bot), the agent accumulates a lot of context files — guides, credentials references, workflow docs, notes. The problem: the agent doesn't know what's there or how to find it fast.

`context-index-mcp` solves this with a simple keyword → file path index exposed as an MCP (Model Context Protocol) server. The agent calls `lookup("animeoshi database")` and instantly gets the file path to read. No embeddings, no vector DB, no API calls — just a JSON file and a scoring function.

---

## How It Works

- **Storage:** A plain `index.json` file (array of entries)
- **Transport:** stdio (MCP standard) — spawned on demand, no persistent daemon
- **Search:** Keyword scoring against tags, title, and description fields
- **Speed:** Sub-100ms per lookup

---

## Tools

### `lookup`
Search for context files by keyword.

```json
{
  "query": "animeoshi database"
}
```

Returns the top 5 matching entries with file paths and instructions to read them.

---

### `add`
Add or update an entry in the index. Uses `file` as the unique key (upsert). On update, omitted optional fields (like `note`) are preserved — pass `"note": ""` to explicitly clear a note. Warns if the file doesn't exist on disk (typo protection).

```json
{
  "title": "AnimeOshi DB Guide",
  "file": "context/animeoshi-db-guide.md",
  "tags": ["animeoshi", "database", "postgres", "sql", "episodes", "ratings"],
  "description": "Schema, credentials, and query examples for the AnimeOshi production DB",
  "note": "Updated 2026-04-01 — readonly user confirmed working"
}
```

---

### `list`
List all entries in the index.

---

### `remove`
Remove an entry by file path.

```json
{
  "file": "context/old-guide.md"
}
```

---

### `doctor`
Check index health. Reports:
- Entries whose files no longer exist on disk (stale entries)
- `context/**/*.md` files in the workspace that aren't indexed yet

Run it occasionally to keep the index and the filesystem in sync.

---

## Installation

```bash
git clone https://github.com/butler-kasagi/context-index-mcp.git
cd context-index-mcp
npm install
```

Recommended install location: inside your agent's workspace, e.g. `workspace/mcp-servers/context-index/`.

`index.json` is **not** shipped in the repo (it's gitignored) — your data file can never be overwritten by a `git pull`. The server starts with an empty index if the file is missing and creates it on the first `add`.

> **Upgrading from ≤1.0?** `index.json` used to be tracked by git. If your local copy has entries, `git pull` will refuse with "your local changes would be overwritten" — copy your `index.json` aside, pull, then put it back. Your data format is unchanged; no migration needed.

---

## Configuration

### Single Agent — With mcporter

Add to your `config/mcporter.json`:

```json
{
  "mcpServers": {
    "context-index": {
      "command": "node",
      "args": ["/path/to/context-index-mcp/index.js"],
      "env": {
        "CONTEXT_INDEX_WORKSPACE": "/path/to/your/workspace"
      }
    }
  }
}
```

> **Setting `CONTEXT_INDEX_WORKSPACE` explicitly is still recommended**, but if it's unset the server infers the workspace instead of blindly trusting `process.cwd()` (MCP launchers often spawn servers from an arbitrary directory, e.g. a `config/` subfolder). Inference order:
> 1. `CONTEXT_INDEX_WORKSPACE` env var — always wins when set
> 2. The ancestor directory (of the cwd or of the index file) where the most index entries resolve to real files
> 3. The nearest ancestor containing a `context/` directory (covers brand-new agents with an empty index)
> 4. `process.cwd()` as a last resort — `doctor` will tell you if this guessed wrong
>
> `doctor` always shows which workspace was resolved and how. The `index.json` data file defaults to sitting next to `index.js`; override with `CONTEXT_INDEX_PATH`.

Then call tools via:
```bash
mcporter call context-index lookup --args '{"query":"your search terms"}'
mcporter call context-index add --args '{"title":"...", "file":"context/...", "tags":["tag1","tag2"], "description":"..."}'
mcporter call context-index list
```

### Multi-Agent Setup (Shared Server, Separate Indexes)

In an OpenClaw multi-agent setup, **each agent has its own workspace directory** and its own `config/mcporter.json`. The key insight is:

- The **server binary** (`index.js`) lives in one place — usually the primary agent's workspace
- Each agent's **`config/mcporter.json`** points to that shared binary, but overrides the workspace and index path via env vars so each agent reads and writes its own isolated data

**Directory layout (real example):**
```
~/.openclaw/
├── workspace/                          ← Butler (primary agent)
│   ├── config/mcporter.json            ← Butler's mcporter config
│   ├── mcp-servers/
│   │   └── context-index/
│   │       ├── index.js                ← shared server binary (one copy)
│   │       └── index.json              ← Butler's index data
│   └── context/
│       └── *.md                        ← Butler's context files
│
├── workspace-starrk/                   ← Starrk (secondary agent)
│   ├── config/mcporter.json            ← Starrk's mcporter config (separate file!)
│   ├── mcp-servers/context-index/
│   │   └── index.json                  ← Starrk's index data (separate!)
│   └── context/
│       └── *.md                        ← Starrk's context files
│
└── workspace-agent-c/                  ← Agent C (any future agent)
    ├── config/mcporter.json            ← Agent C's mcporter config
    ├── mcp-servers/context-index/
    │   └── index.json                  ← Agent C's index data
    └── context/
        └── *.md
```

> **Key rule:** Every workspace has its own `config/mcporter.json`. This is what makes each agent independent — they share the server code but have completely isolated indexes and workspace scopes.

**Butler's** `~/.openclaw/workspace/config/mcporter.json`:
```json
{
  "mcpServers": {
    "context-index": {
      "command": "node",
      "args": ["/Users/you/.openclaw/workspace/mcp-servers/context-index/index.js"],
      "env": {
        "CONTEXT_INDEX_WORKSPACE": "/Users/you/.openclaw/workspace"
      }
    }
  }
}
```
*(Set the workspace explicitly even for the primary agent — don't rely on the launcher's cwd)*

**Starrk's** `~/.openclaw/workspace-starrk/config/mcporter.json`:
```json
{
  "mcpServers": {
    "context-index": {
      "command": "node",
      "args": ["/Users/you/.openclaw/workspace/mcp-servers/context-index/index.js"],
      "env": {
        "CONTEXT_INDEX_WORKSPACE": "/Users/you/.openclaw/workspace-starrk",
        "CONTEXT_INDEX_PATH": "/Users/you/.openclaw/workspace-starrk/mcp-servers/context-index/index.json"
      }
    }
  }
}
```

**Agent C's** `~/.openclaw/workspace-agent-c/config/mcporter.json`:
```json
{
  "mcpServers": {
    "context-index": {
      "command": "node",
      "args": ["/Users/you/.openclaw/workspace/mcp-servers/context-index/index.js"],
      "env": {
        "CONTEXT_INDEX_WORKSPACE": "/Users/you/.openclaw/workspace-agent-c",
        "CONTEXT_INDEX_PATH": "/Users/you/.openclaw/workspace-agent-c/mcp-servers/context-index/index.json"
      }
    }
  }
}
```

**Env vars:**

| Variable | Purpose | Default |
|---|---|---|
| `CONTEXT_INDEX_WORKSPACE` | Root path that file entries resolve against in `lookup` results | Inferred from where index entries resolve / nearest `context/` dir; `process.cwd()` as last resort |
| `CONTEXT_INDEX_PATH` | Path to the `index.json` data file | `index.json` next to `index.js` |

> **Tip:** If you're setting up a new agent, just start calling `mcporter call context-index add` — the `index.json` is created automatically on the first add. Run `doctor` afterwards to spot any context files you forgot to index.

### With OpenClaw

Add to the agent's `openclaw.json`:

```json
{
  "mcp": {
    "servers": {
      "context-index": {
        "command": "node",
        "args": ["/path/to/context-index-mcp/index.js"],
        "env": {
          "CONTEXT_INDEX_WORKSPACE": "/path/to/agent/workspace"
        }
      }
    }
  }
}
```

For multi-agent OpenClaw setups, use mcporter's per-agent `config/mcporter.json` with env vars (see above) rather than the global `openclaw.json`.

### With Claude Desktop / any MCP client

Add to your MCP client config:

```json
{
  "mcpServers": {
    "context-index": {
      "command": "node",
      "args": ["/path/to/context-index-mcp/index.js"],
      "env": {
        "CONTEXT_INDEX_WORKSPACE": "/path/to/your/workspace"
      }
    }
  }
}
```

---

## Data Format

`index.json` structure:

```json
{
  "entries": [
    {
      "title": "Production DB Guide",
      "file": "context/database-guide.md",
      "tags": ["database", "postgres", "sql", "schema"],
      "description": "Schema and query examples for the production database",
      "note": "readonly user, host: db.example.internal",
      "updatedAt": "2026-01-01T08:30:00.000Z"
    }
  ]
}
```

The `file` field is the unique key. Paths are relative to your workspace root (set via the `CONTEXT_INDEX_WORKSPACE` env var, defaults to the server's working directory).

Writes are atomic (temp file + rename), so a crash can't corrupt the index. If the file is ever hand-edited into invalid JSON, the server backs up the broken file as `index.json.corrupt-<timestamp>` and reports a clear error instead of silently starting over. External edits to `index.json` are picked up automatically (the in-memory cache invalidates on file mtime change).

---

## Search Scoring

Entries are ranked by weighted keyword matching:

| Match type | Score |
|---|---|
| Exact tag match | +4 |
| Tag word match | +2 |
| Title word match | +2 |
| Description word match | +1 |
| Note word match | +1 |

Matching is word-boundary based with prefix tolerance: `"deploying"` matches the tag `deploy`, but short fragments don't match mid-word (`"api"` will not match `"rapid"`).

Score is then multiplied by the fraction of query terms that matched at least one field, penalising entries that only match 1 of 5 search terms.

Lookup results flag entries whose files no longer exist on disk and show how long ago each entry was last updated, so the agent knows when context might be stale.

---

## Why Not a Vector DB?

For a personal agent's context index (tens to low hundreds of files), semantic search is overkill:
- No API key needed
- No embedding latency
- Fully offline
- The agent controls the tags — so precision is high anyway

If you scale to thousands of entries with fuzzy natural-language queries, a vector store makes more sense.

---

## The Context File Pattern

The real power of this tool comes from pairing the index with **context files** — plain markdown files that document your workflows, tools, credentials references, and SOPs. The index is just the lookup layer; the content lives in the files.

### How It Works in Practice

```
your-workspace/
├── context/
│   ├── deploy-to-production.md     ← step-by-step deploy workflow
│   ├── database-guide.md           ← schema, connection info, query examples
│   ├── n8n-publishing-workflow.md  ← how to publish HTML via n8n webhook
│   ├── slack-channel-ids.md        ← channel IDs, bot config
│   └── onboarding-checklist.md     ← new team member steps
└── index.json                      ← the index pointing to all of the above
```

When the agent needs to deploy something, it doesn't have to guess or hallucinate — it looks up `"deploy production"`, gets the file path, reads the exact steps.

### What Goes in a Context File?

A good context file answers: *"If I were a new engineer starting this task from scratch, what would I need to know?"*

**Example — `context/deploy-to-production.md`:**
```markdown
# Deploy to Production Guide

## SSH Access
Host: 203.0.113.10   ← replace with your server IP
User: deploy
Key: ~/.ssh/id_ed25519

## Steps
1. SSH into the instance
2. cd /home/godju/app && git pull origin main
3. pm2 restart app
4. Verify: curl https://api.example.com/health

## Rollback
git checkout <previous-tag> && pm2 restart app

## Notes
- Always pull before restarting — never edit files directly on the server
- If pm2 is not running: pm2 start ecosystem.config.js
```

**Example — `context/database-guide.md`:**
```markdown
# Production Database

## Connection
Host: db.example.internal:5432
DB: myapp
User: readonly
Password: (stored in connections.md — never commit)

## Key Tables
- public.anime — anime metadata, mal_id, title, release_year
- public.episodes — episode list per anime
- anime.episode_ratings — user ratings per episode

## Common Queries
-- Top rated episodes this week
SELECT e.title, AVG(r.rating) as avg_rating, COUNT(*) as votes
FROM anime.episode_ratings r
JOIN public.episodes e ON e.id = r.episode_id
WHERE r.created_at > NOW() - INTERVAL '7 days'
GROUP BY e.id ORDER BY avg_rating DESC LIMIT 10;
```

---

## Instructing Your AI Agent

After installing, add these instructions to your agent's system prompt or workspace config file (e.g. `AGENTS.md`, `CLAUDE.md`, or your agent's memory file):

### Minimal Instruction
```
## Context Index

Before performing any task, if you need workflow steps, credentials references,
or tool documentation, search the context index first:

  mcporter call context-index.lookup query="<keywords>"

This returns a file path. Read that file for exact instructions.
Always index new workflows you create:

  mcporter call context-index.add \
    title="..." file="context/xxx.md" tags='["tag1","tag2"]' description="..."
```

### Full Instruction (Recommended)
```
## Context Index (Fast Lookup)

Primary tool for finding context files — use this FIRST before guessing.

  mcporter call context-index.lookup --args '{"query":"<keywords>"}'

Returns file paths instantly. Examples:
- "deploy production ssh" → context/deploy-to-production.md
- "database schema queries" → context/database-guide.md
- "n8n webhook publish html" → context/n8n-publishing-workflow.md

**When creating new context files — ALWAYS index them:**

  mcporter call context-index.add --args '{
    "title": "...",
    "file": "context/xxx.md",
    "tags": ["tag1", "tag2"],
    "description": "One-line summary of what this file contains"
  }'

Never leave a workflow undocumented. If you figure out how to do something
non-obvious (SSH access, API quirks, deploy steps, tool configs), write it
to a context file and index it immediately. Future sessions will thank you.
```

### Example Agent Prompt Flows

**User asks:** *"Deploy the latest build to production"*

Agent flow:
1. `context-index.lookup("deploy production")` → returns `context/deploy-to-production.md`
2. Agent reads the file → gets exact SSH host, commands, rollback steps
3. Executes with confidence — no hallucinated paths or wrong flags

---

**User asks:** *"Query how many users rated episodes this week"*

Agent flow:
1. `context-index.lookup("database episode ratings query")` → returns `context/database-guide.md`
2. Agent reads the file → gets connection details + example SQL
3. Runs the query using the correct credentials and table names

---

**Agent just figured out a new workflow:**

Agent flow:
1. Writes `context/new-workflow.md` with the steps documented
2. `context-index.add(title="...", file="context/new-workflow.md", tags=[...], description="...")`
3. Next session: the workflow is instantly findable — zero context loss

---

## License

MIT
