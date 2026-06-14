'use strict';

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const db = require('./db');

const DEFAULT_PORT = 7890;

// ── CORS ───────────────────────────────────────────────────────────────────
// Only allow Chrome extensions and same-origin requests (no Origin header).
// This service is localhost-only; reject external origins.
const corsOptions = {
  origin(origin, callback) {
    if (!origin || origin.startsWith('chrome-extension://')) {
      callback(null, true);
    } else {
      callback(new Error('CORS: origin not allowed'));
    }
  }
};

// ── Rate limiters ──────────────────────────────────────────────────────────
const exportLimiter = rateLimit({ windowMs: 60_000, limit: 20 });
const uiLimiter = rateLimit({ windowMs: 60_000, limit: 200 });

function createApp(dbPath) {
  db.init(dbPath);

  const app = express();

  app.use(cors(corsOptions));
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Record a navigation event
  app.post('/api/events', (req, res) => {
    try {
      const result = db.insertEvent(req.body);
      if (!result) {
        return res.status(204).json({ skipped: true });
      }
      res.status(201).json(result);
    } catch (err) {
      console.error('Error inserting event:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Update event title (called when tab title resolves)
  app.patch('/api/events/:id', (req, res) => {
    try {
      db.updateEventTitle(Number(req.params.id), req.body.title);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // List events
  app.get('/api/events', (req, res) => {
    try {
      const events = db.getEvents({
        sessionId: req.query.session,
        limit: req.query.limit ? Number(req.query.limit) : 100,
        offset: req.query.offset ? Number(req.query.offset) : 0,
        url: req.query.url
      });
      res.json(events);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get navigation tree
  app.get('/api/tree', (req, res) => {
    try {
      const sessionId = req.query.session;
      if (!sessionId) {
        // Return tree for the most recent session
        const latest = db.getLatestSession();
        if (!latest) return res.json([]);
        return res.json(db.buildTree(latest.id));
      }
      res.json(db.buildTree(sessionId));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // List sessions
  app.get('/api/sessions', (req, res) => {
    try {
      res.json(db.getSessions(req.query.limit ? Number(req.query.limit) : 50));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get domain stats
  app.get('/api/stats', (req, res) => {
    try {
      res.json(db.getDomainStats(req.query.session));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Export data (rate-limited: 20 requests/minute per client)
  app.get('/api/export', exportLimiter, (req, res) => {
    try {
      const format = req.query.format || 'json';
      const data = db.exportData({ sessionId: req.query.session, format });

      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="browser-history.csv"');
      } else if (format === 'markdown') {
        res.setHeader('Content-Type', 'text/markdown');
        res.setHeader('Content-Disposition', 'attachment; filename="browser-history.md"');
      } else {
        res.setHeader('Content-Type', 'application/json');
      }

      res.send(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Serve the web UI for all other routes (rate-limited: 200 requests/minute)
  app.get('*', uiLimiter, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  return app;
}

function startServer(options = {}) {
  const port = options.port || DEFAULT_PORT;
  const app = createApp(options.dbPath);
  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`Browser History Tree service running at http://localhost:${port}`);
    console.log(`Web UI: http://localhost:${port}`);
    console.log(`API:    http://localhost:${port}/api`);
    if (options.dbPath) {
      console.log(`DB:     ${options.dbPath}`);
    }
  });
  return server;
}

module.exports = { createApp, startServer, DEFAULT_PORT };
