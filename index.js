const express = require('express');
const crypto = require('crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

const app = express();

const TARGET = 'https://consoleblue.triadblue.com';
const PORT = process.env.PORT || 3000;
const GITHUB_ORG = process.env.GITHUB_ORG || 'TRIADBLUE';
const GITHUB_API = 'https://api.github.com';

// --- CORS middleware (must be first) ---
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, x-api-key, Authorization, mcp-session-id, Mcp-Session-Id, Last-Event-ID, MCP-Protocol-Version');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, Mcp-Session-Id, MCP-Protocol-Version');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());

// --- GitHub API helper ---
function ghHeaders() {
  const h = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'consoleblue-github-proxy/1.0',
  };
  if (process.env.GITHUB_TOKEN) {
    h['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return h;
}

async function ghFetch(path) {
  const url = `${GITHUB_API}${path}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status}: ${body}`);
  }
  return res.json();
}

// --- In-memory event store for session resumability ---
class InMemoryEventStore {
  constructor() {
    this.events = new Map();
  }

  async storeEvent(streamId, message) {
    const eventId = `${streamId}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    this.events.set(eventId, { streamId, message });
    if (this.events.size > 1000) {
      const keys = [...this.events.keys()];
      for (let i = 0; i < keys.length - 1000; i++) {
        this.events.delete(keys[i]);
      }
    }
    return eventId;
  }

  async replayEventsAfter(lastEventId, { send }) {
    if (!lastEventId || !this.events.has(lastEventId)) return '';
    const parts = lastEventId.split('_');
    const streamId = parts.length > 0 ? parts[0] : '';
    if (!streamId) return '';
    let foundLast = false;
    const sorted = [...this.events.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [eventId, { streamId: sid, message }] of sorted) {
      if (sid !== streamId) continue;
      if (eventId === lastEventId) { foundLast = true; continue; }
      if (foundLast) await send(eventId, message);
    }
    return streamId;
  }
}

// --- MCP Server setup ---
function createMcpServer() {
  const server = new McpServer({
    name: 'triadblue-github',
    version: '1.0.0',
  });

  server.tool('list_repos', 'List all repositories in the TRIADBLUE org', {}, async () => {
    const repos = await ghFetch(`/orgs/${GITHUB_ORG}/repos?per_page=100`);
    const summary = repos.map(r => ({
      name: r.name,
      description: r.description,
      language: r.language,
      updated_at: r.updated_at,
      html_url: r.html_url,
      default_branch: r.default_branch,
      private: r.private,
    }));
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  });

  server.tool('get_repo', 'Get details about a specific repo', {
    repo: z.string().describe('Repository name'),
  }, async ({ repo }) => {
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('list_files', 'List files and directories in a repo path', {
    repo: z.string().describe('Repository name'),
    path: z.string().optional().describe('Directory path (empty for root)'),
  }, async ({ repo, path }) => {
    const p = path || '';
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/contents/${p}`);
    const listing = Array.isArray(data)
      ? data.map(f => ({ name: f.name, type: f.type, size: f.size, path: f.path }))
      : [{ name: data.name, type: data.type, size: data.size, path: data.path }];
    return { content: [{ type: 'text', text: JSON.stringify(listing, null, 2) }] };
  });

  server.tool('read_file', 'Read the contents of a file in a repo', {
    repo: z.string().describe('Repository name'),
    path: z.string().describe('File path'),
  }, async ({ repo, path }) => {
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/contents/${path}`);
    if (data.type !== 'file') {
      return { content: [{ type: 'text', text: `Error: ${path} is a ${data.type}, not a file` }], isError: true };
    }
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return { content: [{ type: 'text', text: content }] };
  });

  server.tool('list_branches', 'List branches of a repo', {
    repo: z.string().describe('Repository name'),
  }, async ({ repo }) => {
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/branches?per_page=100`);
    const branches = data.map(b => ({ name: b.name, sha: b.commit.sha }));
    return { content: [{ type: 'text', text: JSON.stringify(branches, null, 2) }] };
  });

  server.tool('list_issues', 'List open issues for a repo', {
    repo: z.string().describe('Repository name'),
    state: z.enum(['open', 'closed', 'all']).optional().describe('Issue state filter'),
  }, async ({ repo, state }) => {
    const s = state || 'open';
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/issues?state=${s}&per_page=50`);
    const issues = data.map(i => ({
      number: i.number,
      title: i.title,
      state: i.state,
      user: i.user.login,
      created_at: i.created_at,
      labels: i.labels.map(l => l.name),
    }));
    return { content: [{ type: 'text', text: JSON.stringify(issues, null, 2) }] };
  });

  server.tool('list_pulls', 'List pull requests for a repo', {
    repo: z.string().describe('Repository name'),
    state: z.enum(['open', 'closed', 'all']).optional().describe('PR state filter'),
  }, async ({ repo, state }) => {
    const s = state || 'open';
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/pulls?state=${s}&per_page=50`);
    const prs = data.map(p => ({
      number: p.number,
      title: p.title,
      state: p.state,
      user: p.user.login,
      created_at: p.created_at,
      head: p.head.ref,
      base: p.base.ref,
    }));
    return { content: [{ type: 'text', text: JSON.stringify(prs, null, 2) }] };
  });

  server.tool('search_code', 'Search for code across all TRIADBLUE repos', {
    query: z.string().describe('Search query (code, filename, etc.)'),
  }, async ({ query }) => {
    const data = await ghFetch(`/search/code?q=${encodeURIComponent(query)}+org:${GITHUB_ORG}&per_page=20`);
    const results = data.items.map(i => ({
      repo: i.repository.full_name,
      file: i.path,
      url: i.html_url,
    }));
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  });

  server.tool('list_commits', 'List recent commits for a repo', {
    repo: z.string().describe('Repository name'),
    branch: z.string().optional().describe('Branch name (defaults to main)'),
  }, async ({ repo, branch }) => {
    const b = branch ? `&sha=${branch}` : '';
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/commits?per_page=20${b}`);
    const commits = data.map(c => ({
      sha: c.sha.slice(0, 7),
      message: c.commit.message.split('\n')[0],
      author: c.commit.author.name,
      date: c.commit.author.date,
    }));
    return { content: [{ type: 'text', text: JSON.stringify(commits, null, 2) }] };
  });

  return server;
}

// --- MCP session management ---
const sessions = new Map(); // sessionId -> { server, transport, createdAt }
const eventStore = new InMemoryEventStore();

function isInitializeRequest(body) {
  if (Array.isArray(body)) return body.some(m => m.method === 'initialize');
  return body?.method === 'initialize';
}

function getSessionId(req) {
  return req.headers['mcp-session-id'] || req.headers['Mcp-Session-Id'];
}

// Session cleanup disabled — clients don't reliably re-initialize after expiry

async function handleMcpPost(req, res) {
  const ts = new Date().toISOString();
  const method = Array.isArray(req.body) ? req.body.map(m => m.method).join(',') : req.body?.method;
  const sessionId = getSessionId(req);
  console.log(`[${ts}] MCP POST method=${method} session=${sessionId || 'none'}`);

  try {
    // Existing session — forward request
    if (sessionId && sessions.has(sessionId)) {
      console.log(`[${ts}] MCP → reusing session ${sessionId}`);
      const { transport } = sessions.get(sessionId);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // New session — initialize
    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        eventStore,
        enableJsonResponse: true, // JSON not SSE — avoids stream close killing session
        onsessioninitialized: (sid) => {
          sessions.set(sid, { server, transport, createdAt: Date.now() });
          console.log(`[${ts}] MCP session created: ${sid} (total: ${sessions.size})`);
        },
        onsessionclosed: (sid) => {
          sessions.delete(sid);
          console.log(`[${ts}] MCP session explicitly closed: ${sid}`);
        },
      });
      const server = createMcpServer();

      // DO NOT set transport.onclose — that fires on every stream end
      // and was killing sessions immediately. Use onsessionclosed instead.

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Session not found
    console.log(`[${ts}] MCP → session not found: ${sessionId}, active: [${[...sessions.keys()].join(', ')}]`);
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad request — missing or invalid session' },
      id: null,
    });
  } catch (err) {
    console.error(`[${ts}] MCP POST error:`, err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  }
}

async function handleMcpGet(req, res) {
  const ts = new Date().toISOString();
  const sessionId = getSessionId(req);
  console.log(`[${ts}] MCP GET session=${sessionId || 'none'}`);

  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId);
    await transport.handleRequest(req, res);
    return;
  }

  // No valid session — return 405 with Allow header
  // (tells Claude "use POST, server is fine" — NOT 501 which means "broken")
  res.setHeader('Allow', 'POST, HEAD');
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed — use POST' },
    id: null,
  });
}

async function handleMcpDelete(req, res) {
  const ts = new Date().toISOString();
  const sessionId = getSessionId(req);
  console.log(`[${ts}] MCP DELETE session=${sessionId || 'none'}`);

  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId);
    await transport.handleRequest(req, res);
    return;
  }

  res.status(404).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Session not found' },
    id: null,
  });
}

function handleMcpHead(req, res) {
  res.setHeader('MCP-Protocol-Version', '2025-11-25');
  res.setHeader('Content-Type', 'application/json');
  res.sendStatus(200);
}

// --- Mount MCP on /mcp (HEAD first so Express doesn't auto-handle via GET) ---
app.head('/mcp', handleMcpHead);
app.post('/mcp', handleMcpPost);
app.get('/mcp', handleMcpGet);
app.delete('/mcp', handleMcpDelete);

// --- Mount MCP on root / too (Claude.ai may use root path) ---
app.head('/', handleMcpHead);
app.post('/', handleMcpPost);
app.delete('/', handleMcpDelete);

// --- REST endpoints for GitHub API ---
app.get('/api/github/repos', async (req, res) => {
  try {
    const repos = await ghFetch(`/orgs/${GITHUB_ORG}/repos?per_page=100`);
    const summary = repos.map(r => ({ name: r.name, description: r.description, language: r.language, updated_at: r.updated_at, html_url: r.html_url }));
    res.json(summary);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/github/files', async (req, res) => {
  const { repo, path } = req.query;
  if (!repo) return res.status(400).json({ error: 'repo parameter required' });
  try {
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/contents/${path || ''}`);
    const listing = Array.isArray(data)
      ? data.map(f => ({ name: f.name, type: f.type, size: f.size, path: f.path }))
      : [{ name: data.name, type: data.type, size: data.size, path: data.path }];
    res.json(listing);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/github/file', async (req, res) => {
  const { repo, path } = req.query;
  if (!repo || !path) return res.status(400).json({ error: 'repo and path parameters required' });
  try {
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/contents/${path}`);
    if (data.type !== 'file') return res.status(400).json({ error: `${path} is a ${data.type}, not a file` });
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    res.type('text/plain').send(content);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/github/commits', async (req, res) => {
  const { repo, branch } = req.query;
  if (!repo) return res.status(400).json({ error: 'repo parameter required' });
  try {
    const b = branch ? `&sha=${branch}` : '';
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/commits?per_page=20${b}`);
    const commits = data.map(c => ({ sha: c.sha.slice(0, 7), message: c.commit.message.split('\n')[0], author: c.commit.author.name, date: c.commit.author.date }));
    res.json(commits);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/github/branches', async (req, res) => {
  const { repo } = req.query;
  if (!repo) return res.status(400).json({ error: 'repo parameter required' });
  try {
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/branches?per_page=100`);
    const branches = data.map(b => ({ name: b.name, sha: b.commit.sha }));
    res.json(branches);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Grep: search within a single file, return matching lines ---
app.get('/api/github/grep', async (req, res) => {
  const { repo, path, q } = req.query;
  if (!repo || !path || !q) return res.status(400).json({ error: 'repo, path, and q parameters required' });
  try {
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/contents/${path}`);
    if (data.type !== 'file') return res.status(400).json({ error: `${path} is a ${data.type}, not a file` });
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    const lines = content.split('\n');
    const matches = [];
    const query = String(q).toLowerCase();
    lines.forEach((line, i) => {
      if (line.toLowerCase().includes(query)) {
        matches.push({ line: i + 1, text: line.trimEnd() });
      }
    });
    res.json({ file: path, query: q, total: matches.length, matches });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Search: search across all files in a repo directory ---
app.get('/api/github/search', async (req, res) => {
  const { repo, path, q, ext } = req.query;
  if (!repo || !q) return res.status(400).json({ error: 'repo and q parameters required' });
  try {
    const dir = path || '';
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/contents/${dir}`);
    if (!Array.isArray(data)) return res.status(400).json({ error: 'path must be a directory' });
    const files = data.filter(f => {
      if (f.type !== 'file') return false;
      if (ext && !f.name.endsWith(String(ext))) return false;
      return true;
    });
    const results = [];
    const query = String(q).toLowerCase();
    for (const f of files.slice(0, 50)) { // limit to 50 files
      try {
        const fileData = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/contents/${f.path}`);
        const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
        const lines = content.split('\n');
        const matches = [];
        lines.forEach((line, i) => {
          if (line.toLowerCase().includes(query)) {
            matches.push({ line: i + 1, text: line.trimEnd() });
          }
        });
        if (matches.length > 0) {
          results.push({ file: f.path, matches });
        }
      } catch (e) { /* skip unreadable files */ }
    }
    res.json({ query: q, directory: dir, filesSearched: files.length, results });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Read file with line range (for large files) ---
app.get('/api/github/lines', async (req, res) => {
  const { repo, path, from, to } = req.query;
  if (!repo || !path) return res.status(400).json({ error: 'repo and path parameters required' });
  try {
    const data = await ghFetch(`/repos/${GITHUB_ORG}/${repo}/contents/${path}`);
    if (data.type !== 'file') return res.status(400).json({ error: `${path} is a ${data.type}, not a file` });
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    const lines = content.split('\n');
    const start = Math.max(1, parseInt(from) || 1);
    const end = Math.min(lines.length, parseInt(to) || lines.length);
    const selected = lines.slice(start - 1, end).map((text, i) => ({
      line: start + i,
      text: text.trimEnd(),
    }));
    res.json({ file: path, totalLines: lines.length, from: start, to: end, lines: selected });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- GET / without session header = health check ---
app.get('/', (req, res) => {
  const sessionId = getSessionId(req);
  if (sessionId && sessions.has(sessionId)) {
    return handleMcpGet(req, res);
  }
  res.json({
    status: 'ok',
    service: 'consoleblue-github-proxy',
    version: '2.3',
    mcp: '/mcp',
    activeSessions: sessions.size,
  });
});

app.listen(PORT, () => {
  console.log(`Proxy + MCP server running on port ${PORT}`);
});
