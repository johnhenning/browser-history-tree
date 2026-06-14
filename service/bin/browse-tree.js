#!/usr/bin/env node
'use strict';

const { program } = require('commander');
const { startServer, DEFAULT_PORT } = require('../src/server');
const db = require('../src/db');
const os = require('os');
const path = require('path');

const DEFAULT_DB_PATH = path.join(os.homedir(), '.browser-history-tree', 'history.db');

program
  .name('browse-tree')
  .description('Browser History Tree — track and explore your navigation history')
  .version('1.0.0');

// ── serve ──────────────────────────────────────────────────────────────────
program
  .command('serve')
  .description('Start the browser history service and web UI')
  .option('-p, --port <number>', 'Port to listen on', String(DEFAULT_PORT))
  .option('-d, --db <path>', 'Path to SQLite database file', DEFAULT_DB_PATH)
  .action(opts => {
    startServer({ port: Number(opts.port), dbPath: opts.db });
  });

// ── sessions ───────────────────────────────────────────────────────────────
program
  .command('sessions')
  .description('List browsing sessions')
  .option('-n, --limit <number>', 'Max sessions to show', '20')
  .option('-d, --db <path>', 'Path to SQLite database file', DEFAULT_DB_PATH)
  .action(opts => {
    db.init(opts.db);
    const sessions = db.getSessions(Number(opts.limit));
    if (sessions.length === 0) {
      console.log('No sessions found. Is the service running and the extension installed?');
      return;
    }

    const header = padRight('ID (short)', 10) + '  ' +
                   padRight('Started', 20) + '  ' +
                   padRight('Ended', 20) + '  ' +
                   padRight('Duration', 10) + '  ' +
                   'Events';
    console.log(header);
    console.log('─'.repeat(header.length));

    sessions.forEach(s => {
      const start = new Date(s.started_at).toLocaleString();
      const end = s.ended_at ? new Date(s.ended_at).toLocaleString() : 'ongoing';
      const durationMs = (s.ended_at || Date.now()) - s.started_at;
      const durationMin = Math.round(durationMs / 60000);
      const shortId = s.id.slice(0, 8);
      console.log(
        padRight(shortId, 10) + '  ' +
        padRight(start, 20) + '  ' +
        padRight(end, 20) + '  ' +
        padRight(`${durationMin}min`, 10) + '  ' +
        s.event_count
      );
    });
  });

// ── list ───────────────────────────────────────────────────────────────────
program
  .command('list')
  .description('List recent navigation events')
  .option('-s, --session <id>', 'Filter by session ID (or "latest")')
  .option('-n, --limit <number>', 'Max events to show', '50')
  .option('-d, --db <path>', 'Path to SQLite database file', DEFAULT_DB_PATH)
  .action(opts => {
    db.init(opts.db);
    let sessionId = opts.session;
    if (sessionId === 'latest') {
      const latest = db.getLatestSession();
      if (!latest) { console.log('No sessions found.'); return; }
      sessionId = latest.id;
    }

    const events = db.getEvents({
      sessionId,
      limit: Number(opts.limit)
    });

    if (events.length === 0) {
      console.log('No events found.');
      return;
    }

    events.forEach(e => {
      const time = new Date(e.timestamp).toLocaleString();
      const type = e.transition_type ? `[${e.transition_type}]` : '';
      const parent = e.parent_event_id ? `← #${e.parent_event_id}` : '';
      const label = e.title && e.title !== e.url ? e.title : '';
      console.log(`#${e.id}  ${time}  ${type}  ${parent}`);
      if (label) console.log(`   ${label}`);
      console.log(`   ${e.url}`);
    });
  });

// ── tree ───────────────────────────────────────────────────────────────────
program
  .command('tree')
  .description('Show the navigation tree as ASCII art')
  .option('-s, --session <id>', 'Session ID (or "latest")', 'latest')
  .option('-d, --db <path>', 'Path to SQLite database file', DEFAULT_DB_PATH)
  .action(opts => {
    db.init(opts.db);
    let sessionId = opts.session;
    if (sessionId === 'latest') {
      const latest = db.getLatestSession();
      if (!latest) { console.log('No sessions found.'); return; }
      sessionId = latest.id;
    }

    const session = db.getSession(sessionId);
    if (!session) { console.log(`Session "${sessionId}" not found.`); return; }

    const start = new Date(session.started_at).toLocaleString();
    console.log(`Session: ${session.id}`);
    console.log(`Started: ${start}`);
    console.log('');

    const roots = db.buildTree(sessionId);
    if (roots.length === 0) {
      console.log('No navigation events in this session.');
      return;
    }

    roots.forEach((root, i) => {
      if (i > 0) console.log('');
      const lines = db.renderTreeAscii(root, 0, true, '');
      lines.forEach(l => console.log(l));
    });
  });

// ── export ─────────────────────────────────────────────────────────────────
program
  .command('export')
  .description('Export navigation history (for AI, spreadsheets, etc.)')
  .option('-s, --session <id>', 'Session ID (or "latest" or "all")', 'all')
  .option('-f, --format <fmt>', 'Output format: json | csv | markdown', 'markdown')
  .option('-o, --output <file>', 'Write to file instead of stdout')
  .option('-d, --db <path>', 'Path to SQLite database file', DEFAULT_DB_PATH)
  .action(opts => {
    db.init(opts.db);
    let sessionId = opts.session;
    if (sessionId === 'latest') {
      const latest = db.getLatestSession();
      if (!latest) { console.log('No sessions found.'); return; }
      sessionId = latest.id;
    } else if (sessionId === 'all') {
      sessionId = undefined;
    }

    const output = db.exportData({ sessionId, format: opts.format });

    if (opts.output) {
      const fs = require('fs');
      fs.writeFileSync(opts.output, output, 'utf8');
      console.log(`Exported to ${opts.output}`);
    } else {
      process.stdout.write(output + '\n');
    }
  });

// ── summary ────────────────────────────────────────────────────────────────
program
  .command('summary')
  .description('Print an AI-ready text summary of your browsing history')
  .option('-s, --session <id>', 'Session ID (or "latest" or "all")', 'latest')
  .option('-d, --db <path>', 'Path to SQLite database file', DEFAULT_DB_PATH)
  .action(opts => {
    db.init(opts.db);
    let sessionId = opts.session;
    if (sessionId === 'latest') {
      const latest = db.getLatestSession();
      if (!latest) { console.log('No sessions found.'); return; }
      sessionId = latest.id;
    } else if (sessionId === 'all') {
      sessionId = undefined;
    }

    const output = db.exportData({ sessionId, format: 'markdown' });
    process.stdout.write(output + '\n');
  });

// ── stats ──────────────────────────────────────────────────────────────────
program
  .command('stats')
  .description('Show domain visit statistics')
  .option('-s, --session <id>', 'Session ID (or "latest")')
  .option('-d, --db <path>', 'Path to SQLite database file', DEFAULT_DB_PATH)
  .action(opts => {
    db.init(opts.db);
    let sessionId = opts.session;
    if (sessionId === 'latest') {
      const latest = db.getLatestSession();
      if (!latest) { console.log('No sessions found.'); return; }
      sessionId = latest.id;
    }

    const stats = db.getDomainStats(sessionId);
    if (stats.length === 0) {
      console.log('No data found.');
      return;
    }

    const max = stats[0].visit_count;
    console.log(padRight('Domain', 40) + '  Visits  Bar');
    console.log('─'.repeat(70));
    stats.forEach(s => {
      const bar = '█'.repeat(Math.round((s.visit_count / max) * 20));
      console.log(padRight(s.domain, 40) + '  ' + padLeft(String(s.visit_count), 6) + '  ' + bar);
    });
  });

// helpers
function padRight(str, len) {
  return String(str).slice(0, len).padEnd(len);
}
function padLeft(str, len) {
  return String(str).padStart(len);
}

program.parse(process.argv);
