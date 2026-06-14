/* global d3 */
'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let currentSessionId = null;
let allNodes = [];
let treeRoots = [];
let simulation = null;
let searchFilter = '';

// ── Bootstrap ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadSessions();
  bindToolbar();
  bindExport();
  bindDetailPanel();

  // Auto-refresh every 30 s
  setInterval(refreshCurrentSession, 30_000);
});

// ── Session loading ────────────────────────────────────────────────────────
async function loadSessions() {
  const list = document.getElementById('session-list');
  try {
    const sessions = await apiFetch('/api/sessions?limit=50');
    list.innerHTML = '';
    if (sessions.length === 0) {
      list.innerHTML = '<div class="loading">No sessions yet. Install the extension and start browsing!</div>';
      return;
    }
    sessions.forEach(s => {
      const item = document.createElement('div');
      item.className = 'session-item';
      item.dataset.id = s.id;

      const start = new Date(s.started_at);
      const end = s.ended_at ? new Date(s.ended_at) : null;
      const durationMs = (s.ended_at || Date.now()) - s.started_at;
      const durationMin = Math.round(durationMs / 60000);

      item.innerHTML = `
        <div class="session-date">${formatDate(start)}</div>
        <div class="session-meta">${formatTime(start)}${end ? ' – ' + formatTime(end) : ' (active)'}  ·  ${durationMin}min  ·  ${s.event_count} events</div>
      `;
      item.addEventListener('click', () => selectSession(s.id, item, s));
      list.appendChild(item);
    });

    // Auto-select the latest session
    const first = list.querySelector('.session-item');
    if (first) first.click();
  } catch (err) {
    list.innerHTML = `<div class="loading">Cannot reach service. Run <code>browse-tree serve</code>.</div>`;
    console.error(err);
  }
}

async function selectSession(sessionId, itemEl, session) {
  currentSessionId = sessionId;

  document.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
  itemEl.classList.add('active');

  // Toolbar label
  const start = new Date(session.started_at);
  document.getElementById('session-label').textContent = `${formatDate(start)} ${formatTime(start)}`;

  await Promise.all([
    loadTree(sessionId),
    loadStats(sessionId)
  ]);
}

async function refreshCurrentSession() {
  if (!currentSessionId) return;
  await loadTree(currentSessionId);
  loadSessions(); // refresh sidebar counts
}

// ── Tree loading ───────────────────────────────────────────────────────────
async function loadTree(sessionId) {
  try {
    treeRoots = await apiFetch(`/api/tree?session=${sessionId}`);
    allNodes = flattenTree(treeRoots);

    document.getElementById('event-count').textContent = `${allNodes.length} pages`;

    // Hide hint
    document.getElementById('tree-hint').style.display = 'none';

    renderActiveView();
  } catch (err) {
    console.error('Failed to load tree:', err);
  }
}

// ── Stats ──────────────────────────────────────────────────────────────────
async function loadStats(sessionId) {
  try {
    const stats = await apiFetch(`/api/stats?session=${sessionId}`);
    const container = document.getElementById('stats-list');
    container.innerHTML = '';
    if (stats.length === 0) return;

    const max = stats[0].visit_count;
    stats.slice(0, 10).forEach(s => {
      const pct = Math.round((s.visit_count / max) * 100);
      const row = document.createElement('div');
      row.className = 'stat-row';
      row.innerHTML = `
        <span class="stat-domain" title="${s.domain}">${s.domain}</span>
        <div class="stat-bar-wrap"><div class="stat-bar" style="width:${pct}%"></div></div>
        <span class="stat-count">${s.visit_count}</span>
      `;
      container.appendChild(row);
    });
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

// ── Toolbar ────────────────────────────────────────────────────────────────
function bindToolbar() {
  document.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`${btn.dataset.view}-view`).classList.add('active');
      renderActiveView();
    });
  });

  document.getElementById('search-input').addEventListener('input', e => {
    searchFilter = e.target.value.toLowerCase().trim();
    renderActiveView();
  });
}

function renderActiveView() {
  const activeView = document.querySelector('.toggle-btn.active').dataset.view;
  if (activeView === 'tree') {
    renderTree();
  } else {
    renderTimeline();
  }
}

// ── D3 Tree Visualization ──────────────────────────────────────────────────
function renderTree() {
  const svg = document.getElementById('tree-svg');
  const width = svg.clientWidth || window.innerWidth - 280;
  const height = svg.clientHeight || window.innerHeight - 56;

  // Clear previous
  d3.select('#tree-svg').selectAll('*').remove();

  const filtered = searchFilter
    ? treeRoots.map(r => filterTree(r, searchFilter)).filter(Boolean)
    : treeRoots;

  if (filtered.length === 0) {
    document.getElementById('tree-hint').style.display = 'flex';
    document.getElementById('tree-hint').textContent =
      searchFilter ? 'No results match your search.' : 'Select a session from the sidebar to view its navigation tree.';
    return;
  }

  document.getElementById('tree-hint').style.display = 'none';

  // Build a synthetic root if there are multiple trees
  const dataRoot = filtered.length === 1
    ? filtered[0]
    : { id: -1, url: '', title: 'Session', timestamp: 0, children: filtered };

  const svgEl = d3.select('#tree-svg')
    .attr('width', width)
    .attr('height', height);

  const g = svgEl.append('g');

  // Zoom behavior
  const zoom = d3.zoom()
    .scaleExtent([0.1, 4])
    .on('zoom', (event) => {
      g.attr('transform', event.transform);
    });
  svgEl.call(zoom);

  // D3 hierarchy
  const hierarchy = d3.hierarchy(dataRoot);
  const nodeCount = hierarchy.descendants().length;

  // Use tree layout with dynamic size
  const nodeSpacing = Math.max(22, Math.min(36, height / (nodeCount + 1)));
  const treeLayout = d3.tree()
    .nodeSize([nodeSpacing, 220])
    .separation((a, b) => a.parent === b.parent ? 1 : 1.4);

  treeLayout(hierarchy);

  // Center vertically
  const nodes = hierarchy.descendants();
  const minY = d3.min(nodes, d => d.x);
  const maxY = d3.max(nodes, d => d.x);
  const treeHeight = maxY - minY;
  const translateY = height / 2 - treeHeight / 2 - minY;
  const translateX = 60;

  g.attr('transform', `translate(${translateX}, ${translateY})`);

  // Links
  g.selectAll('.link')
    .data(hierarchy.links())
    .join('path')
    .attr('class', 'link')
    .attr('d', d3.linkHorizontal()
      .x(d => d.y)
      .y(d => d.x)
    );

  // Nodes
  const node = g.selectAll('.node')
    .data(nodes)
    .join('g')
    .attr('class', 'node')
    .attr('transform', d => `translate(${d.y},${d.x})`)
    .style('cursor', d => d.data.id === -1 ? 'default' : 'pointer')
    .on('click', (event, d) => {
      if (d.data.id === -1) return;
      showDetail(d.data, buildAncestorPath(d));
    })
    .on('mouseover', (event, d) => showTooltip(event, d.data))
    .on('mouseout', hideTooltip);

  // Skip rendering the synthetic root node
  node.filter(d => d.data.id !== -1)
    .append('circle')
    .attr('r', d => d.children && d.children.length > 0 ? 6 : 5)
    .attr('fill', d => domainColor(d.data.url))
    .attr('stroke', d => domainColor(d.data.url));

  node.filter(d => d.data.id !== -1)
    .append('text')
    .attr('dy', '0.31em')
    .attr('x', d => d.children ? -10 : 10)
    .attr('text-anchor', d => d.children ? 'end' : 'start')
    .text(d => truncate(d.data.title || extractDomain(d.data.url), 28));

  // Initial zoom to fit
  const bounds = g.node().getBBox();
  const scaleX = (width - 120) / bounds.width;
  const scaleY = (height - 40) / bounds.height;
  const scale = Math.min(Math.min(scaleX, scaleY), 1.5);
  svgEl.call(
    zoom.transform,
    d3.zoomIdentity
      .translate(width / 2 - (bounds.x + bounds.width / 2) * scale,
                 height / 2 - (bounds.y + bounds.height / 2) * scale)
      .scale(scale)
  );
}

function buildAncestorPath(d3Node) {
  const path = [];
  let current = d3Node;
  while (current) {
    if (current.data.id !== -1) path.unshift(current.data);
    current = current.parent;
  }
  return path;
}

// ── Timeline View ──────────────────────────────────────────────────────────
function renderTimeline() {
  const container = document.getElementById('timeline-content');
  container.innerHTML = '';

  const filtered = searchFilter
    ? treeRoots.map(r => filterTree(r, searchFilter)).filter(Boolean)
    : treeRoots;

  if (filtered.length === 0) {
    container.innerHTML = '<div class="loading">No events to display.</div>';
    return;
  }

  filtered.forEach((root, i) => {
    const section = document.createElement('div');
    section.className = 'timeline-root';

    const header = document.createElement('div');
    header.className = 'timeline-root-header';
    header.innerHTML = `
      <span class="timeline-root-badge">${root.transitionType || 'navigation'}</span>
      <span>${root.title || extractDomain(root.url)}</span>
    `;
    section.appendChild(header);

    renderTimelineEntries(root, section, 0);
    container.appendChild(section);
  });
}

function renderTimelineEntries(node, container, depth) {
  if (!node || node.id === -1) return;

  const entry = document.createElement('div');
  entry.className = 'timeline-entry';
  entry.style.marginLeft = `${depth * 16}px`;

  const domain = extractDomain(node.url);
  const dotColor = domainColor(node.url);
  entry.style.setProperty('--dot-color', dotColor);

  entry.innerHTML = `
    <span class="te-time">${formatTime(new Date(node.timestamp))}</span>
    <div class="te-content">
      <div class="te-title">${escapeHtml(node.title || domain)}</div>
      <a class="te-url" href="${escapeHtml(node.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(node.url)}</a>
    </div>
    ${node.transitionType ? `<span class="te-badge">${node.transitionType}</span>` : ''}
  `;

  // Style the dot using domainColor
  entry.style.borderLeftColor = dotColor;

  entry.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') return;
    showDetail(node, [node]);
  });

  container.appendChild(entry);

  (node.children || []).forEach(child => renderTimelineEntries(child, container, depth + 1));
}

// ── Tooltip ────────────────────────────────────────────────────────────────
function showTooltip(event, data) {
  if (!data || data.id === -1) return;
  const tt = document.getElementById('tooltip');
  tt.innerHTML = `
    <div class="tt-title">${escapeHtml(data.title || extractDomain(data.url))}</div>
    <div class="tt-url">${escapeHtml(data.url)}</div>
    <div class="tt-time">${formatDateTime(new Date(data.timestamp))}${data.transitionType ? '  ·  ' + data.transitionType : ''}</div>
  `;
  tt.classList.remove('hidden');
  positionTooltip(event, tt);
}

function hideTooltip() {
  document.getElementById('tooltip').classList.add('hidden');
}

function positionTooltip(event, tt) {
  const margin = 12;
  const x = Math.min(event.clientX + margin, window.innerWidth - tt.offsetWidth - margin);
  const y = Math.min(event.clientY + margin, window.innerHeight - tt.offsetHeight - margin);
  tt.style.left = `${x}px`;
  tt.style.top = `${y}px`;
}

document.getElementById('tree-svg').addEventListener('mousemove', (e) => {
  const tt = document.getElementById('tooltip');
  if (!tt.classList.contains('hidden')) positionTooltip(e, tt);
});

// ── Detail Panel ───────────────────────────────────────────────────────────
function bindDetailPanel() {
  document.getElementById('detail-close').addEventListener('click', () => {
    document.getElementById('detail-panel').classList.add('hidden');
  });
}

function showDetail(node, path) {
  const panel = document.getElementById('detail-panel');

  document.getElementById('detail-title').textContent = node.title || extractDomain(node.url);
  const urlEl = document.getElementById('detail-url');
  urlEl.textContent = node.url;
  urlEl.href = node.url;

  document.getElementById('detail-time').textContent = formatDateTime(new Date(node.timestamp));
  document.getElementById('detail-transition').textContent = node.transitionType || 'unknown';
  document.getElementById('detail-session').textContent = currentSessionId ? currentSessionId.slice(0, 8) + '…' : '—';

  const pathList = document.getElementById('detail-path-list');
  pathList.innerHTML = '';
  path.forEach(p => {
    const li = document.createElement('li');
    li.textContent = p.title || extractDomain(p.url);
    li.title = p.url;
    pathList.appendChild(li);
  });

  panel.classList.remove('hidden');
}

// ── Export ─────────────────────────────────────────────────────────────────
function bindExport() {
  document.querySelectorAll('.btn[data-format]').forEach(btn => {
    btn.addEventListener('click', () => exportData(btn.dataset.format));
  });
}

async function exportData(format) {
  const sessionParam = currentSessionId ? `&session=${currentSessionId}` : '';
  const url = `/api/export?format=${format}${sessionParam}`;

  try {
    const feedback = document.getElementById('export-feedback');
    feedback.classList.remove('hidden');

    if (format === 'markdown') {
      const text = await fetch(url).then(r => r.text());
      await navigator.clipboard.writeText(text);
      feedback.textContent = '✓ Copied to clipboard!';
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = `browser-history.${format === 'json' ? 'json' : 'csv'}`;
      a.click();
      feedback.textContent = '✓ Download started';
    }

    setTimeout(() => feedback.classList.add('hidden'), 3000);
  } catch (err) {
    console.error('Export failed:', err);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
async function apiFetch(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function flattenTree(roots) {
  const out = [];
  function walk(node) {
    out.push(node);
    (node.children || []).forEach(walk);
  }
  roots.forEach(walk);
  return out;
}

function filterTree(node, query) {
  if (!node) return null;
  const matches =
    (node.url && node.url.toLowerCase().includes(query)) ||
    (node.title && node.title.toLowerCase().includes(query));
  const filteredChildren = (node.children || [])
    .map(c => filterTree(c, query))
    .filter(Boolean);

  if (matches || filteredChildren.length > 0) {
    return { ...node, children: filteredChildren };
  }
  return null;
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url || '';
  }
}

// Color by domain using a consistent hash
function domainColor(url) {
  const domain = extractDomain(url);
  let hash = 0;
  for (let i = 0; i < domain.length; i++) {
    hash = domain.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 60%)`;
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len - 1) + '…' : str;
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(d) {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(d) {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(d) {
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}
