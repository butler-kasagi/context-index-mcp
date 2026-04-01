#!/usr/bin/env node
/**
 * context-index MCP Server
 * Lightweight keyword → file path index for fast context retrieval.
 * Much faster than Augment - returns file paths instantly, no embeddings.
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, 'index.json');
const WORKSPACE = '/Users/butler/.openclaw/workspace';

// Load or init index
function loadIndex() {
  if (fs.existsSync(INDEX_PATH)) {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  }
  return { entries: [] };
}

function saveIndex(index) {
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
}

// Search: match keywords against entry tags/title/description
function search(index, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = index.entries.map(entry => {
    const tags = (entry.tags || []).map(t => t.toLowerCase());
    const title = (entry.title || '').toLowerCase();
    const desc = (entry.description || '').toLowerCase();

    let score = 0;
    for (const term of terms) {
      // Exact tag match = highest weight
      if (tags.includes(term)) score += 4;
      // Tag contains term
      else if (tags.some(t => t.includes(term))) score += 2;
      // Title match
      if (title.includes(term)) score += 2;
      // Description match
      if (desc.includes(term)) score += 1;
    }

    // Bonus: what % of query terms matched (penalizes entries that only match 1 of 5 terms)
    const matched = terms.filter(t =>
      tags.some(tag => tag.includes(t)) || title.includes(t) || desc.includes(t)
    ).length;
    const coverage = matched / terms.length;
    score = score * coverage;

    return { entry, score };
  });

  return scored
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(r => r.entry);
}

const server = new Server(
  { name: 'context-index', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'lookup',
      description: 'Look up context files by keyword. Returns file paths + instructions to read them.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords to search for (e.g. "animeoshi database", "gsc search console", "ai enrichment ssh")' }
        },
        required: ['query']
      }
    },
    {
      name: 'add',
      description: 'Add or update an entry in the context index.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title for this entry' },
          file: { type: 'string', description: 'File path relative to workspace (e.g. context/animeoshi-db-guide.md)' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Keywords/tags for matching' },
          description: { type: 'string', description: 'One-line description of what this file contains' },
          note: { type: 'string', description: 'Optional latest note or context to attach (e.g. "last checked Feb 25, progress 23%")' }
        },
        required: ['title', 'file', 'tags', 'description']
      }
    },
    {
      name: 'list',
      description: 'List all entries in the context index.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'remove',
      description: 'Remove an entry from the context index by file path.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'File path to remove' }
        },
        required: ['file']
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const index = loadIndex();

  if (name === 'lookup') {
    const results = search(index, args.query);
    if (results.length === 0) {
      return { content: [{ type: 'text', text: `No results found for: "${args.query}"\n\nTry: context-index.list to see all entries.` }] };
    }
    const output = results.slice(0, 5).map(e => {
      const fullPath = path.join(WORKSPACE, e.file);
      return [
        `📄 **${e.title}**`,
        `   File: ${fullPath}`,
        `   Description: ${e.description}`,
        e.note ? `   Latest: ${e.note}` : null,
        `   Tags: ${(e.tags || []).join(', ')}`,
        `   → READ: ${fullPath}`
      ].filter(Boolean).join('\n');
    }).join('\n\n');

    return { content: [{ type: 'text', text: `Found ${results.length} result(s) for "${args.query}":\n\n${output}` }] };
  }

  if (name === 'add') {
    const existing = index.entries.findIndex(e => e.file === args.file);
    const entry = {
      title: args.title,
      file: args.file,
      tags: args.tags,
      description: args.description,
      note: args.note || null,
      updatedAt: new Date().toISOString()
    };
    if (existing >= 0) {
      index.entries[existing] = entry;
    } else {
      index.entries.push(entry);
    }
    saveIndex(index);
    return { content: [{ type: 'text', text: `✅ Added/updated: "${args.title}" → ${args.file}` }] };
  }

  if (name === 'list') {
    if (index.entries.length === 0) {
      return { content: [{ type: 'text', text: 'Index is empty. Use context-index.add to add entries.' }] };
    }
    const output = index.entries.map((e, i) =>
      `${i + 1}. **${e.title}** (${e.file})\n   ${e.description}\n   Tags: ${(e.tags || []).join(', ')}`
    ).join('\n\n');
    return { content: [{ type: 'text', text: `${index.entries.length} entries:\n\n${output}` }] };
  }

  if (name === 'remove') {
    const before = index.entries.length;
    index.entries = index.entries.filter(e => e.file !== args.file);
    saveIndex(index);
    const removed = before - index.entries.length;
    return { content: [{ type: 'text', text: removed > 0 ? `✅ Removed: ${args.file}` : `Not found: ${args.file}` }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
