'use strict';

const SERVICE_URL = 'http://localhost:7890';

async function init() {
  // Check service status
  let online = false;
  try {
    const res = await fetch(`${SERVICE_URL}/api/sessions?limit=1`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      online = true;
      const sessions = await res.json();
      updateSessionStats(sessions);
    }
  } catch {
    // Service offline
  }

  updateStatus(online);
  updateQueueCount();
  updateCurrentTab();
}

function updateStatus(online) {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  dot.className = `status-dot ${online ? 'online' : 'offline'}`;
  text.textContent = online ? 'Service online' : 'Service offline';
}

async function updateSessionStats(sessions) {
  if (!sessions || sessions.length === 0) return;
  const latest = sessions[0];

  try {
    const events = await fetch(
      `${SERVICE_URL}/api/events?session=${latest.id}&limit=1`
    ).then(r => r.json());
    document.getElementById('event-count').textContent = latest.event_count || 0;
  } catch {
    document.getElementById('event-count').textContent = latest.event_count || 0;
  }
}

async function updateQueueCount() {
  const { offlineQueue = [] } = await chrome.storage.local.get('offlineQueue');
  const count = offlineQueue.length;
  document.getElementById('queue-count').textContent = count;
  if (count > 0) {
    document.getElementById('queue-notice').style.display = 'block';
  }
}

async function updateCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && !tab.url.startsWith('chrome://')) {
    const el = document.getElementById('current-url');
    el.textContent = tab.url.replace(/^https?:\/\//, '').slice(0, 60) +
      (tab.url.length > 70 ? '…' : '');
  }
}

// Open web UI
document.getElementById('btn-open-ui').addEventListener('click', () => {
  chrome.tabs.create({ url: SERVICE_URL });
  window.close();
});

// Copy AI summary to clipboard
document.getElementById('btn-copy-summary').addEventListener('click', async () => {
  const btn = document.getElementById('btn-copy-summary');
  btn.textContent = 'Copying…';
  try {
    const text = await fetch(`${SERVICE_URL}/api/export?format=markdown`).then(r => r.text());
    await navigator.clipboard.writeText(text);
    btn.textContent = '✓ Copied!';
  } catch {
    btn.textContent = 'Service offline';
  }
  setTimeout(() => { btn.textContent = 'Copy Summary'; }, 2000);
});

init();
