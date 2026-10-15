'use strict';
// Tools the agent can use. Each has a definition (what Claude sees) and a run() function.
// To add a tool: copy one of these blocks, give it a new name, and write its run().
const fs = require('fs');
const path = require('path');
const config = require('./config');

const NOTES_DIR = path.join(config.dataDir, 'notes');
fs.mkdirSync(NOTES_DIR, { recursive: true });

const noteName = (n) =>
  String(n || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'note';

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

function isPrivateHost(host) {
  return (
    /^(localhost|0\.|127\.|10\.|192\.168\.|169\.254\.|\[?::1\]?$|\[?fc|\[?fd)/i.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === 'metadata.google.internal'
  );
}

const tools = {
  fetch_url: {
    label: 'Read a web page',
    definition: {
      name: 'fetch_url',
      description:
        'Fetch a public web page and return its readable text (up to about 12,000 characters). Use it to read a specific URL in full.',
      input_schema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Full http(s) URL' } },
        required: ['url'],
      },
    },
    async run({ url }) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      try {
        // Follow up to 5 redirects by hand so each hop is checked against the block list.
        let res;
        for (let hop = 0; ; hop++) {
          if (!/^https?:\/\//i.test(url || '')) throw new Error('URL must start with http:// or https://');
          if (isPrivateHost(new URL(url).hostname)) throw new Error('Private and internal addresses are blocked.');
          res = await fetch(url, {
            signal: ctrl.signal,
            redirect: 'manual',
            headers: { 'user-agent': 'AgentStation/0.1' },
          });
          const next = res.headers.get('location');
          if (res.status >= 300 && res.status < 400 && next) {
            if (hop >= 5) throw new Error('Too many redirects.');
            url = new URL(next, url).toString();
            continue;
          }
          break;
        }
        const type = res.headers.get('content-type') || '';
        const body = await res.text();
        const text = type.includes('html') ? htmlToText(body) : body;
        const cut = text.length > 12000;
        return `Status ${res.status}\n\n${text.slice(0, 12000)}${cut ? '\n\n[truncated]' : ''}`;
      } finally {
        clearTimeout(t);
      }
    },
  },

  save_note: {
    label: 'Save a note',
    definition: {
      name: 'save_note',
      description:
        'Save text to a named note (overwrites a note with the same name). Notes persist between tasks, so use them to keep results, lists and working memory.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short name, e.g. "etsy-trends"' },
          content: { type: 'string', description: 'The full text to save' },
        },
        required: ['name', 'content'],
      },
    },
    async run({ name, content }) {
      const n = noteName(name);
      fs.writeFileSync(path.join(NOTES_DIR, n + '.md'), String(content ?? ''));
      return `Saved note "${n}" (${String(content ?? '').length} characters).`;
    },
  },

  read_note: {
    label: 'Read a note',
    definition: {
      name: 'read_note',
      description: 'Read a saved note by name. Call with no name to list all saved notes.',
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Note name (leave empty to list notes)' } },
      },
    },
    async run({ name } = {}) {
      if (!name) {
        const names = listNotes().map((n) => `- ${n.name} (${n.size} chars)`);
        return names.length ? `Saved notes:\n${names.join('\n')}` : 'No notes saved yet.';
      }
      const file = path.join(NOTES_DIR, noteName(name) + '.md');
      if (!fs.existsSync(file)) throw new Error(`No note called "${noteName(name)}".`);
      return fs.readFileSync(file, 'utf8');
    },
  },
};

function listNotes() {
  return fs
    .readdirSync(NOTES_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const stat = fs.statSync(path.join(NOTES_DIR, f));
      return { name: f.slice(0, -3), size: stat.size, updatedAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function readNote(name) {
  const file = path.join(NOTES_DIR, noteName(name) + '.md');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

module.exports = { tools, listNotes, readNote };
