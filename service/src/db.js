'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');

const DEFAULT_DB_PATH = path.join(os.homedir(), '.browser-history-tree', 'history.db');
const SESSION_INACTIVITY_MS = 30 * 60 * 1000; // 30 minutes

let db;

function init(dbPath) {
  const resolvedPath = dbPath || DEFAULT_DB_PATH;
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  db = new DatabaseSync(resolvedPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  createSchema();
  return db;
}

function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      label TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      timestamp INTEGER NOT NULL,
      tab_id INTEGER,
      parent_event_id INTEGER,
      transition_type TEXT,
      transition_qualifiers TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id),
      FOREIGN KEY (parent_event_id) REFERENCES events(id)
    );

    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_parent ON events(parent_event_id);
  `);
}

function getOrCreateActiveSession() {
  // Find the most recent session
  const lastSession = db.prepare(
    'SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1'
  ).get();

  if (lastSession) {
    // Find the last event in this session
    const lastEvent = db.prepare(
      'SELECT timestamp FROM events WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1'
    ).get(lastSession.id);

    const lastActivity = lastEvent ? lastEvent.timestamp : lastSession.started_at;
    const now = Date.now();

    if (now - lastActivity < SESSION_INACTIVITY_MS) {
      return lastSession.id;
    }
  }

  // Create a new session
  const id = randomUUID();
  db.prepare('INSERT INTO sessions (id, started_at) VALUES (?, ?)').run(id, Date.now());
  return id;
}

function insertEvent(event) {
  const {
    url,
    title,
    timestamp,
    tabId,
    parentEventId,
    transitionType,
    transitionQualifiers,
    sessionId
  } = event;

  // Skip chrome internal pages
  if (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('about:') ||
    url.startsWith('devtools://')
  ) {
    return null;
  }

  const session = sessionId || getOrCreateActiveSession();

  // Update session ended_at
  db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(Date.now(), session);

  const result = db.prepare(`
    INSERT INTO events (session_id, url, title, timestamp, tab_id, parent_event_id, transition_type, transition_qualifiers)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session,
    url,
    title || null,
    timestamp || Date.now(),
    tabId || null,
    parentEventId || null,
    transitionType || null,
    transitionQualifiers ? JSON.stringify(transitionQualifiers) : null
  );

  return { id: result.lastInsertRowid, sessionId: session };
}

function updateEventTitle(eventId, title) {
  db.prepare('UPDATE events SET title = ? WHERE id = ?').run(title, eventId);
}

function getSessions(limit) {
  const sessions = db.prepare(`
    SELECT s.*,
           COUNT(e.id) as event_count
    FROM sessions s
    LEFT JOIN events e ON e.session_id = s.id
    GROUP BY s.id
    ORDER BY s.started_at DESC
    LIMIT ?
  `).all(limit || 50);
  return sessions;
}

function getSession(sessionId) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
}

function getLatestSession() {
  return db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1').get();
}

function getEvents(options = {}) {
  const { sessionId, limit, offset, url } = options;
  let query = 'SELECT * FROM events WHERE 1=1';
  const params = [];

  if (sessionId) {
    query += ' AND session_id = ?';
    params.push(sessionId);
  }
  if (url) {
    query += ' AND url LIKE ?';
    params.push(`%${url}%`);
  }

  query += ' ORDER BY timestamp DESC';

  if (limit) {
    query += ' LIMIT ?';
    params.push(limit);
  }
  if (offset) {
    query += ' OFFSET ?';
    params.push(offset);
  }

  return db.prepare(query).all(...params);
}

function buildTree(sessionId) {
  const events = db.prepare(
    'SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC'
  ).all(sessionId);

  const nodeMap = new Map();
  events.forEach(e => {
    nodeMap.set(e.id, {
      id: e.id,
      url: e.url,
      title: e.title || e.url,
      timestamp: e.timestamp,
      transitionType: e.transition_type,
      children: []
    });
  });

  const roots = [];
  events.forEach(e => {
    const node = nodeMap.get(e.id);
    if (e.parent_event_id && nodeMap.has(e.parent_event_id)) {
      nodeMap.get(e.parent_event_id).children.push(node);
    } else {
      roots.push(node);
    }
  });

  return roots;
}

function getDomainStats(sessionId) {
  let query = `
    SELECT
      LOWER(SUBSTR(url, INSTR(url, '://') + 3,
        CASE
          WHEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') > 0
          THEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') - 1
          ELSE LENGTH(SUBSTR(url, INSTR(url, '://') + 3))
        END
      )) as domain,
      COUNT(*) as visit_count
    FROM events
  `;
  const params = [];
  if (sessionId) {
    query += ' WHERE session_id = ?';
    params.push(sessionId);
  }
  query += ' GROUP BY domain ORDER BY visit_count DESC LIMIT 20';
  return db.prepare(query).all(...params);
}

function exportData(options = {}) {
  const { sessionId, format } = options;
  const sessions = sessionId
    ? [getSession(sessionId)].filter(Boolean)
    : getSessions(100);

  const result = sessions.map(session => {
    const trees = buildTree(session.id);
    const stats = getDomainStats(session.id);
    return { session, trees, stats };
  });

  if (format === 'json') {
    return JSON.stringify(result, null, 2);
  }

  if (format === 'csv') {
    const rows = ['id,session_id,url,title,timestamp,parent_event_id,transition_type'];
    sessions.forEach(session => {
      const events = getEvents({ sessionId: session.id });
      events.forEach(e => {
        const row = [
          e.id,
          e.session_id,
          `"${(e.url || '').replace(/"/g, '""')}"`,
          `"${(e.title || '').replace(/"/g, '""')}"`,
          e.timestamp,
          e.parent_event_id || '',
          e.transition_type || ''
        ].join(',');
        rows.push(row);
      });
    });
    return rows.join('\n');
  }

  // Default: markdown
  return generateMarkdown(result);
}

function generateMarkdown(sessionData) {
  const lines = ['# Browser History Summary', ''];

  sessionData.forEach(({ session, trees, stats }) => {
    const start = new Date(session.started_at).toLocaleString();
    const end = session.ended_at ? new Date(session.ended_at).toLocaleString() : 'ongoing';
    const durationMs = (session.ended_at || Date.now()) - session.started_at;
    const durationMin = Math.round(durationMs / 60000);

    lines.push(`## Session: ${start} — ${end} (${durationMin} min)`);
    if (session.label) lines.push(`**Label:** ${session.label}`);
    lines.push('');

    if (trees.length === 0) {
      lines.push('*No navigation events recorded.*');
      lines.push('');
      return;
    }

    lines.push('### Navigation Paths');
    lines.push('');

    let pathIndex = 1;
    trees.forEach(root => {
      lines.push(`**Path ${pathIndex++}** *(${root.transitionType || 'unknown'} — ${new Date(root.timestamp).toLocaleTimeString()})*`);
      renderTreeMarkdown(root, lines, 0);
      lines.push('');
    });

    if (stats.length > 0) {
      lines.push('### Top Domains');
      lines.push('');
      stats.slice(0, 10).forEach(s => {
        lines.push(`- **${s.domain}**: ${s.visit_count} visit${s.visit_count !== 1 ? 's' : ''}`);
      });
      lines.push('');
    }
  });

  return lines.join('\n');
}

function renderTreeMarkdown(node, lines, depth) {
  const indent = '  '.repeat(depth);
  const prefix = depth === 0 ? '' : '↳ ';
  const time = new Date(node.timestamp).toLocaleTimeString();
  const label = node.title !== node.url ? `${node.title} (${node.url})` : node.url;
  lines.push(`${indent}${prefix}${label} — ${time}`);
  node.children.forEach(child => renderTreeMarkdown(child, lines, depth + 1));
}

function renderTreeAscii(node, depth, isLast, prefix) {
  const connector = depth === 0 ? '' : (isLast ? '└─ ' : '├─ ');
  const childPrefix = depth === 0 ? '' : (isLast ? '   ' : '│  ');
  const time = new Date(node.timestamp).toLocaleTimeString();
  const label = node.title && node.title !== node.url
    ? `${node.title}`
    : node.url.replace(/^https?:\/\//, '');
  const lines = [`${prefix}${connector}${label}  [${time}]`];
  node.children.forEach((child, i) => {
    const last = i === node.children.length - 1;
    lines.push(...renderTreeAscii(child, depth + 1, last, prefix + childPrefix));
  });
  return lines;
}

module.exports = {
  init,
  insertEvent,
  updateEventTitle,
  getSessions,
  getSession,
  getLatestSession,
  getEvents,
  buildTree,
  getDomainStats,
  exportData,
  generateMarkdown,
  renderTreeAscii,
  getOrCreateActiveSession,
  DEFAULT_DB_PATH
};
