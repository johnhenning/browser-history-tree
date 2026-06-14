'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const db = require('./db');

const TEST_DB_PATH = path.join(os.tmpdir(), `bht-test-${Date.now()}.db`);

before(() => {
  db.init(TEST_DB_PATH);
});

after(() => {
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }
});

test('insertEvent creates an event and returns id + sessionId', () => {
  const result = db.insertEvent({
    url: 'https://example.com',
    title: 'Example Domain',
    timestamp: Date.now(),
    transitionType: 'typed'
  });
  assert.ok(result, 'result should not be null');
  assert.ok(typeof result.id === 'number', 'id should be a number');
  assert.ok(typeof result.sessionId === 'string', 'sessionId should be a string');
});

test('insertEvent skips chrome:// URLs', () => {
  const result = db.insertEvent({ url: 'chrome://newtab/', timestamp: Date.now() });
  assert.strictEqual(result, null, 'chrome:// URLs should be skipped');
});

test('insertEvent skips about: URLs', () => {
  const result = db.insertEvent({ url: 'about:blank', timestamp: Date.now() });
  assert.strictEqual(result, null);
});

test('insertEvent records parent-child relationship', () => {
  const parent = db.insertEvent({
    url: 'https://google.com',
    title: 'Google',
    timestamp: Date.now(),
    transitionType: 'typed'
  });
  const child = db.insertEvent({
    url: 'https://github.com',
    title: 'GitHub',
    timestamp: Date.now() + 1000,
    transitionType: 'link',
    parentEventId: parent.id,
    sessionId: parent.sessionId
  });
  assert.ok(child, 'child event should be created');

  const events = db.getEvents({ sessionId: parent.sessionId });
  const childEvent = events.find(e => e.id === child.id);
  assert.strictEqual(childEvent.parent_event_id, parent.id);
});

test('updateEventTitle updates the title', () => {
  const result = db.insertEvent({
    url: 'https://example.org',
    timestamp: Date.now(),
    transitionType: 'typed'
  });
  db.updateEventTitle(result.id, 'Updated Title');

  const events = db.getEvents({ sessionId: result.sessionId });
  const event = events.find(e => e.id === result.id);
  assert.strictEqual(event.title, 'Updated Title');
});

test('getSessions returns sessions with event counts', () => {
  db.insertEvent({ url: 'https://session-test.com', timestamp: Date.now() });
  const sessions = db.getSessions(10);
  assert.ok(sessions.length > 0, 'should have at least one session');
  const s = sessions[0];
  assert.ok('id' in s);
  assert.ok('started_at' in s);
  assert.ok('event_count' in s);
  assert.ok(s.event_count >= 0);
});

test('getEvents filters by sessionId', () => {
  const r1 = db.insertEvent({ url: 'https://filter-test.com/a', timestamp: Date.now() });
  db.insertEvent({ url: 'https://filter-test.com/b', timestamp: Date.now() + 1 });

  const filtered = db.getEvents({ sessionId: r1.sessionId });
  assert.ok(filtered.every(e => e.session_id === r1.sessionId));
});

test('buildTree returns hierarchical structure', () => {
  const root = db.insertEvent({
    url: 'https://tree-root.com',
    title: 'Root',
    timestamp: Date.now(),
    transitionType: 'typed'
  });
  const child1 = db.insertEvent({
    url: 'https://tree-child1.com',
    title: 'Child1',
    timestamp: Date.now() + 100,
    transitionType: 'link',
    parentEventId: root.id,
    sessionId: root.sessionId
  });
  db.insertEvent({
    url: 'https://tree-child2.com',
    title: 'Child2',
    timestamp: Date.now() + 200,
    transitionType: 'link',
    parentEventId: child1.id,
    sessionId: root.sessionId
  });

  const trees = db.buildTree(root.sessionId);
  const rootNode = trees.find(n => n.id === root.id);
  assert.ok(rootNode, 'root node should be in tree');
  assert.ok(rootNode.children.length >= 1, 'root should have children');

  const child1Node = rootNode.children.find(n => n.id === child1.id);
  assert.ok(child1Node, 'child1 should be under root');
  assert.ok(child1Node.children.length >= 1, 'child1 should have children');
});

test('getDomainStats returns domain counts', () => {
  const session = db.insertEvent({
    url: 'https://stats-domain.com/page1',
    timestamp: Date.now()
  });
  db.insertEvent({
    url: 'https://stats-domain.com/page2',
    timestamp: Date.now() + 1,
    sessionId: session.sessionId
  });

  const stats = db.getDomainStats(session.sessionId);
  assert.ok(stats.length > 0);
  const statsDomain = stats.find(s => s.domain.includes('stats-domain'));
  assert.ok(statsDomain, 'stats-domain.com should appear in stats');
  assert.ok(statsDomain.visit_count >= 2);
});

test('exportData produces valid JSON', () => {
  const session = db.insertEvent({
    url: 'https://export-test.com',
    title: 'Export Test',
    timestamp: Date.now(),
    transitionType: 'typed'
  });
  const json = db.exportData({ sessionId: session.sessionId, format: 'json' });
  const parsed = JSON.parse(json);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.length > 0);
  assert.ok(parsed[0].session);
  assert.ok(parsed[0].trees);
});

test('exportData produces valid CSV', () => {
  const session = db.insertEvent({
    url: 'https://csv-test.com',
    title: 'CSV Test',
    timestamp: Date.now()
  });
  const csv = db.exportData({ sessionId: session.sessionId, format: 'csv' });
  const lines = csv.split('\n');
  assert.ok(lines[0].startsWith('id,session_id,url'));
  assert.ok(lines.length > 1);
});

test('exportData produces markdown', () => {
  const session = db.insertEvent({
    url: 'https://md-test.com',
    title: 'Markdown Test',
    timestamp: Date.now()
  });
  const md = db.exportData({ sessionId: session.sessionId, format: 'markdown' });
  assert.ok(md.startsWith('# Browser History Summary'));
  assert.ok(md.includes('Session:'));
});

test('renderTreeAscii returns array of strings', () => {
  const node = {
    id: 1,
    url: 'https://example.com',
    title: 'Example',
    timestamp: Date.now(),
    transitionType: 'typed',
    children: [{
      id: 2,
      url: 'https://example.com/page',
      title: 'Page',
      timestamp: Date.now(),
      transitionType: 'link',
      children: []
    }]
  };
  const lines = db.renderTreeAscii(node, 0, true, '');
  assert.ok(Array.isArray(lines));
  assert.ok(lines.length >= 2);
  assert.ok(lines[0].includes('Example'));
  assert.ok(lines[1].includes('Page'));
});
