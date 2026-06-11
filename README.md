# context-index-mcp

A lightweight context index MCP server for AI agents. Maps keywords to file paths instantly. No embeddings, no vector DB, no API keys — just a JSON file and a scoring function.

**Author:** Marcus Low Wern Chien (marcuslowwernchien@gmail.com)

## How It Works

- **Storage:** Plain `index.json` file (array of entries).
- **Transport:** stdio (MCP standard) — spawned on demand.
- **Search:** Keyword scoring against tags, title, and description.
- **Speed:** Sub-100ms per lookup.

## Tools

- `lookup`: Search by keyword. Returns top 5 matches with file paths and read instructions.
- `add`: Upsert entry by `file`. Omitted fields are preserved (pass `"note": ""` to clear). Warns if file doesn't exist.
- `list`: List all entries.
- `remove`: Remove entry by `file`.
- `doctor`: Checks health. Reports missing files on disk and unindexed `context/**/*.md` files.

## Installation

```bash
git clone https://github.com/butler-kasagi/context-index-mcp.git
cd context-index-mcp
npm install
```

> **Note:** `index.json` is gitignored — your data won't be overwritten by a `git pull`. The server creates it on the first `add`.

## Configuration

### Single Agent (mcporter)

Add to `config/mcporter.json`:

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

*Note: If `CONTEXT_INDEX_WORKSPACE` is unset, the server attempts to infer the workspace from existing index paths or the nearest `context/` directory before falling back to `process.cwd()`.*

### Multi-Agent Setup (OpenClaw)

Each agent has its own workspace and `config/mcporter.json`.

#### Method 1: Isolated Copy (Recommended for Secondary Agents)

Copy the server into the secondary agent's workspace. This ensures `__dirname` resolves locally, keeping the agent's index data safely isolated.

**Step 1: Copy the server**
```bash
mkdir -p /absolute/path/to/workspace-agent/mcp-servers/context-index
cp /absolute/path/to/primary-workspace/mcp-servers/context-index/index.js \
   /absolute/path/to/workspace-agent/mcp-servers/context-index/index.js
```

**Step 2: Install dependencies**
```bash
cd /absolute/path/to/workspace-agent/mcp-servers/context-index
npm init -y
npm install @modelcontextprotocol/sdk
```

**Step 3: Create `config/mcporter.json`**
```json
{
  "mcpServers": {
    "context-index": {
      "command": "node",
      "args": ["/absolute/path/to/workspace-agent/mcp-servers/context-index/index.js"],
      "env": {
        "CONTEXT_INDEX_WORKSPACE": "/absolute/path/to/workspace-agent"
      }
    }
  }
}
```
> ⚠️ **Crucial rules for secondary agents:**
> - Use **absolute paths everywhere** in the JSON config.
> - If `mcporter` is not installed, install it globally: `npm install -g mcporter`.

**Step 4: Verify the setup**
Run from the secondary workspace root:
```bash
cd /absolute/path/to/workspace-agent
mcporter call context-index doctor
```
*Expected healthy output:*
```
Index health (0 entries, workspace: /absolute/path/to/workspace-agent [CONTEXT_INDEX_WORKSPACE env var])
✅ All entries point to existing files, and every context/*.md file is indexed.
```

#### Method 2: Shared Binary (Advanced)

Share one `index.js` across agents.
**Warning:** You **must** set `CONTEXT_INDEX_PATH` in every secondary agent's config. If omitted, the `__dirname` fallback will overwrite the primary agent's `index.json`!

**Secondary Agent** `config/mcporter.json`:
```json
{
  "mcpServers": {
    "context-index": {
      "command": "node",
      "args": ["/absolute/path/to/primary/mcp-servers/context-index/index.js"],
      "env": {
        "CONTEXT_INDEX_WORKSPACE": "/absolute/path/to/workspace-agent",
        "CONTEXT_INDEX_PATH": "/absolute/path/to/workspace-agent/mcp-servers/context-index/index.json"
      }
    }
  }
}
```

**Environment Variables:**

| Variable | Purpose | Default |
|---|---|---|
| `CONTEXT_INDEX_WORKSPACE` | Root path for `file` entries in lookup results. | Inferred from entries / `context/` dir / `process.cwd()`. |
| `CONTEXT_INDEX_PATH` | Path to `index.json` data file. | `index.json` next to `index.js`. |

### With OpenClaw / Claude Desktop

Add to `openclaw.json` or your MCP client config:

```json
{
  "mcpServers": {
    "context-index": {
      "command": "node",
      "args": ["/path/to/context-index-mcp/index.js"],
      "env": {
        "CONTEXT_INDEX_WORKSPACE": "/path/to/agent/workspace"
      }
    }
  }
}
```

## Data Format

`index.json` stores an array of objects. `file` is the unique key (paths relative to `CONTEXT_INDEX_WORKSPACE`).

```json
{
  "entries": [
    {
      "title": "DB Guide",
      "file": "context/database-guide.md",
      "tags": ["database", "sql"],
      "description": "Schema and query examples",
      "note": "readonly user",
      "updatedAt": "2026-01-01T08:30:00.000Z"
    }
  ]
}
```
Writes are atomic, preventing corruption on crash. External edits trigger auto-reloads.

## Search Scoring

Ranked by weighted keyword matching:

| Match type | Score |
|---|---|
| Exact tag match | +4 |
| Tag word match | +2 |
| Title word match | +2 |
| Description / Note word match | +1 |

Word-boundary based with prefix tolerance (`"deploying"` matches tag `"deploy"`). Entries are penalised if they match fewer query terms. 

*Why not a Vector DB?* For personal agent contexts (low hundreds of files), tag-based keyword matching is faster, fully offline, and highly precise since the agent controls the tags.

## The Context File Pattern

Pair this index with plain markdown files that document workflows, credentials, and SOPs.
Example `context/deploy-to-production.md`:
```markdown
# Deploy Guide
Host: 203.0.113.10
User: deploy

1. SSH in
2. `cd app && git pull origin main`
3. `pm2 restart app`
```

## Instructing Your AI Agent

Add this to your agent's system prompt (e.g. `AGENTS.md`):

```text
Before performing any task needing workflows, credentials, or tool docs, search the context index:
  mcporter call context-index lookup --args '{"query":"<keywords>"}'

Always index new context files you create immediately:
  mcporter call context-index add --args '{"title":"...", "file":"context/xxx.md", "tags":["tag1"], "description":"..."}'
```

## License

MIT
