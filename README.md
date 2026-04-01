# context-index-mcp

A lightweight, zero-dependency context index MCP server for AI agents.

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
Add or update an entry in the index. Uses `file` as the unique key (upsert).

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

## Installation

```bash
git clone https://github.com/butler-kasagi/context-index-mcp.git
cd context-index-mcp
npm install
```

---

## Configuration

### With mcporter

Add to your mcporter config:

```json
{
  "servers": {
    "context-index": {
      "command": "node",
      "args": ["/path/to/context-index-mcp/index.js"]
    }
  }
}
```

Then call tools via:
```bash
mcporter call context-index.lookup query="your search terms"
mcporter call context-index.add title="..." file="..." tags='["tag1","tag2"]' description="..."
```

### With Claude Desktop / any MCP client

Add to your MCP client config:

```json
{
  "mcpServers": {
    "context-index": {
      "command": "node",
      "args": ["/path/to/context-index-mcp/index.js"]
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

The `file` field is the unique key. Paths are relative to your workspace root (configurable in `index.js` via the `WORKSPACE` constant).

---

## Search Scoring

Entries are ranked by weighted keyword matching:

| Match type | Score |
|---|---|
| Exact tag match | +4 |
| Tag contains term | +2 |
| Title contains term | +2 |
| Description contains term | +1 |

Score is then multiplied by the fraction of query terms that matched at least one field, penalising entries that only match 1 of 5 search terms.

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
