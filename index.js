#!/usr/bin/env node
/**
 * context-index MCP Server
 * Lightweight keyword → file path index for fast context retrieval.
 * No embeddings, no external services — a JSON file and a scoring function.
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const fs = require('fs');
const path = require('path');

const INDEX_PATH = process.env.CONTEXT_INDEX_PATH || path.join(__dirname, 'index.json');

// Workspace resolution. CONTEXT_INDEX_WORKSPACE always wins; without it the
// launcher's cwd is unreliable (MCP clients spawn servers from arbitrary
// directories), so infer the root from evidence instead of trusting cwd:
// the directory where index entries actually resolve to real files, or
// failing that, the nearest ancestor that holds a context/ directory.
function resolveWorkspace() {
  if (process.env.CONTEXT_INDEX_WORKSPACE) {
    return { root: process.env.CONTEXT_INDEX_WORKSPACE, source: 'CONTEXT_INDEX_WORKSPACE env var' };
  }

  const candidates = [];
  for (const start of [process.cwd(), path.dirname(INDEX_PATH)]) {
    let dir = path.resolve(start);
    for (let i = 0; i < 8; i++) {
      if (!candidates.includes(dir)) candidates.push(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  let entries = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    if (Array.isArray(parsed.entries)) entries = parsed.entries.slice(0, 50);
  } catch { /* no readable index yet — fall through to the marker heuristic */ }

  const relative = entries.filter(e => e.file && !path.isAbsolute(e.file));
  if (relative.length > 0) {
    let best = null, bestHits = 0;
    for (const c of candidates) {
      const hits = relative.filter(e => fs.existsSync(path.join(c, e.file))).length;
      if (hits > bestHits) { best = c; bestHits = hits; }
    }
    if (best) return { root: best, source: `inferred — ${bestHits}/${relative.length} index entries resolve here` };
  }

  for (const c of candidates) {
    try {
      if (fs.statSync(path.join(c, 'context')).isDirectory()) {
        return { root: c, source: 'inferred — nearest ancestor containing a context/ directory' };
      }
    } catch { /* keep walking */ }
  }

  return { root: process.cwd(), source: 'process cwd fallback — set CONTEXT_INDEX_WORKSPACE to be explicit' };
}

const { root: WORKSPACE, source: WORKSPACE_SOURCE } = resolveWorkspace();

// Cache is invalidated on mtime change so external edits (or a second server
// process pointed at the same file) are picked up instead of overwritten.
let cachedIndex = null;
let cachedMtime = null;

function loadIndex() {
  let mtime;
  try {
    mtime = fs.statSync(INDEX_PATH).mtimeMs;
  } catch {
    cachedIndex = { entries: [] };
    cachedMtime = null;
    return cachedIndex;
  }
  if (cachedIndex && mtime === cachedMtime) return cachedIndex;

  const raw = fs.readFileSync(INDEX_PATH, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const backup = `${INDEX_PATH}.corrupt-${Date.now()}`;
    fs.writeFileSync(backup, raw);
    cachedIndex = null;
    cachedMtime = null;
    throw new Error(
      `Index file at ${INDEX_PATH} is not valid JSON (${err.message}). ` +
      `It was backed up to ${backup} — repair or delete the index file, then retry.`
    );
  }
  if (!Array.isArray(parsed.entries)) parsed.entries = [];
  cachedIndex = parsed;
  cachedMtime = mtime;
  return cachedIndex;
}

function saveIndex(index) {
  fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
  // Write to a temp file and rename so a crash mid-write can't corrupt the index.
  const tmp = `${INDEX_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n');
  fs.renameSync(tmp, INDEX_PATH);
  cachedIndex = index;
  cachedMtime = fs.statSync(INDEX_PATH).mtimeMs;
}

function resolvePath(file) {
  return path.isAbsolute(file) ? file : path.join(WORKSPACE, file);
}

// --- Search ---

function tokenize(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// Word-boundary match with prefix tolerance: "deploying" matches "deploy",
// but "api" does not match "rapid". Prefixes only count from 4 chars so short
// terms stay exact.
function termMatchesWord(term, word) {
  if (term === word) return true;
  if (word.length >= 4 && term.startsWith(word)) return true;
  if (term.length >= 4 && word.startsWith(term)) return true;
  return false;
}

function search(index, query) {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const scored = index.entries.map(entry => {
    const tags = (entry.tags || []).map(t => String(t).toLowerCase().trim());
    const tagWords = (entry.tags || []).flatMap(tokenize);
    const titleWords = tokenize(entry.title);
    const descWords = tokenize(entry.description);
    const noteWords = tokenize(entry.note);

    let score = 0;
    let matched = 0;
    for (const term of terms) {
      let hit = false;
      // Exact whole-tag match = highest weight
      if (tags.includes(term)) { score += 4; hit = true; }
      // Tag word match
      else if (tagWords.some(w => termMatchesWord(term, w))) { score += 2; hit = true; }
      // Title match
      if (titleWords.some(w => termMatchesWord(term, w))) { score += 2; hit = true; }
      // Description match
      if (descWords.some(w => termMatchesWord(term, w))) { score += 1; hit = true; }
      // Note match
      if (noteWords.some(w => termMatchesWord(term, w))) { score += 1; hit = true; }
      if (hit) matched++;
    }

    // Penalize entries that only match a fraction of the query terms
    score = score * (matched / terms.length);
    return { entry, score };
  });

  return scored
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(r => r.entry);
}

function formatAge(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  const days = Math.floor(ms / 86400000);
  if (days < 1) return 'today';
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

const server = new Server(
  { name: 'context-index', version: '1.1.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      'Keyword → file-path index for this workspace\'s context files (workflows, tool docs, credential references, SOPs).',
      'Call lookup FIRST before guessing at workflow steps or configs — it returns file paths to read for exact instructions.',
      'After creating or significantly changing a context file, call add to index it so future sessions can find it.',
      'Run doctor occasionally to find stale entries (missing files) and unindexed context files.'
    ].join(' ')
  }
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
      },
      annotations: { readOnlyHint: true }
    },
    {
      name: 'add',
      description: 'Add or update an entry in the context index. Upserts by file path; fields you omit (e.g. note) are preserved on update.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title for this entry' },
          file: { type: 'string', description: 'File path relative to workspace (e.g. context/animeoshi-db-guide.md)' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Keywords/tags for matching' },
          description: { type: 'string', description: 'One-line description of what this file contains' },
          note: { type: 'string', description: 'Optional latest note or context to attach (e.g. "last checked Feb 25, progress 23%"). Omit to keep the existing note; pass "" to clear it.' }
        },
        required: ['title', 'file', 'tags', 'description']
      },
      annotations: { destructiveHint: false, idempotentHint: true }
    },
    {
      name: 'list',
      description: 'List all entries in the context index.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true }
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
      },
      annotations: { destructiveHint: true, idempotentHint: true }
    },
    {
      name: 'doctor',
      description: 'Check index health: reports entries whose files no longer exist, and context/*.md files that are not indexed yet.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true }
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
      const fullPath = resolvePath(e.file);
      const exists = fs.existsSync(fullPath);
      const age = formatAge(e.updatedAt);
      return [
        `📄 **${e.title}**`,
        `   File: ${fullPath}${exists ? '' : '   ⚠️ FILE NOT FOUND — entry may be stale, run context-index.doctor'}`,
        `   Description: ${e.description}`,
        e.note ? `   Latest: ${e.note}` : null,
        `   Tags: ${(e.tags || []).join(', ')}`,
        age ? `   Indexed/updated: ${age}` : null,
        exists ? `   → READ: ${fullPath}` : null
      ].filter(Boolean).join('\n');
    }).join('\n\n');

    return { content: [{ type: 'text', text: `Found ${results.length} result(s) for "${args.query}":\n\n${output}` }] };
  }

  if (name === 'add') {
    const existing = index.entries.findIndex(e => e.file === args.file);
    const prev = existing >= 0 ? index.entries[existing] : {};
    const entry = {
      ...prev,
      title: args.title,
      file: args.file,
      tags: args.tags,
      description: args.description,
      updatedAt: new Date().toISOString()
    };
    // Only touch the note when explicitly provided ("" clears it); otherwise keep the old one
    if (args.note !== undefined) entry.note = args.note || null;
    else if (entry.note === undefined) entry.note = null;

    if (existing >= 0) {
      index.entries[existing] = entry;
    } else {
      index.entries.push(entry);
    }
    saveIndex(index);

    const fullPath = resolvePath(args.file);
    const warn = fs.existsSync(fullPath)
      ? ''
      : `\n⚠️ ${fullPath} does not exist yet — check the path for typos, or create the file.`;
    return { content: [{ type: 'text', text: `✅ Added/updated: "${args.title}" → ${args.file}${warn}` }] };
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

  if (name === 'doctor') {
    const missing = index.entries.filter(e => !fs.existsSync(resolvePath(e.file)));

    const contextDir = path.join(WORKSPACE, 'context');
    let unindexed = [];
    if (fs.existsSync(contextDir)) {
      const indexed = new Set(index.entries.map(e => path.normalize(resolvePath(e.file))));
      unindexed = fs.readdirSync(contextDir, { recursive: true })
        .map(f => path.join(contextDir, String(f)))
        .filter(f => f.endsWith('.md') && fs.statSync(f).isFile() && !indexed.has(path.normalize(f)))
        .map(f => path.relative(WORKSPACE, f));
    }

    const lines = [`Index health (${index.entries.length} entries, workspace: ${WORKSPACE} [${WORKSPACE_SOURCE}])`];
    if (index.entries.length > 0 && missing.length === index.entries.length) {
      lines.push(
        '',
        '🚨 ALL entries point to missing files — the workspace root is almost certainly wrong, not the index.',
        `   Current workspace: ${WORKSPACE} (${WORKSPACE_SOURCE})`,
        '   Fix: set the CONTEXT_INDEX_WORKSPACE env var in the MCP server config to the agent\'s workspace root.'
      );
    } else if (missing.length > 0) {
      lines.push('', `⚠️ ${missing.length} entr${missing.length === 1 ? 'y points' : 'ies point'} to missing files (fix the path or context-index.remove):`);
      for (const e of missing) lines.push(`   - ${e.file} ("${e.title}")`);
    }
    if (unindexed.length > 0) {
      lines.push('', `📂 ${unindexed.length} context file(s) not in the index (document with context-index.add):`);
      for (const f of unindexed) lines.push(`   - ${f}`);
    }
    if (missing.length === 0 && unindexed.length === 0) {
      lines.push('', '✅ All entries point to existing files, and every context/*.md file is indexed.');
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
