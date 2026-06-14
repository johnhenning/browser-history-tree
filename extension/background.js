/**
 * Browser History Tree — Background Service Worker
 *
 * Tracks tab navigation events and sends them to the local service at
 * http://localhost:7890.
 *
 * State is kept in-memory (Map) for performance, and synced to
 * chrome.storage.session so it survives service-worker restarts within the
 * same browser session (Chrome 102+).
 */

'use strict';

const SERVICE_URL = 'http://localhost:7890';

// in-memory state: tabId → { url, lastEventId, pendingParentEventId }
const tabState = new Map();

// ── Restore state after service-worker wake-up ─────────────────────────────
chrome.storage.session.get('tabState').then(data => {
  if (data.tabState) {
    Object.entries(data.tabState).forEach(([k, v]) => tabState.set(Number(k), v));
  }
}).catch(() => {}); // storage.session not available in older Chrome versions

function persistTabState() {
  const obj = {};
  tabState.forEach((v, k) => { obj[k] = v; });
  chrome.storage.session.set({ tabState: obj }).catch(() => {});
}

// ── Tab lifecycle ──────────────────────────────────────────────────────────

// When a new tab is created, capture the opener tab's last event as the
// pending parent for the first navigation in the new tab.
chrome.tabs.onCreated.addListener(tab => {
  const opener = tab.openerTabId;
  if (opener !== undefined && opener !== null && tabState.has(opener)) {
    tabState.set(tab.id, {
      url: null,
      lastEventId: null,
      pendingParentEventId: tabState.get(opener).lastEventId
    });
    persistTabState();
  }
});

// Clean up closed tabs
chrome.tabs.onRemoved.addListener(tabId => {
  tabState.delete(tabId);
  persistTabState();
});

// ── Navigation tracking ────────────────────────────────────────────────────
chrome.webNavigation.onCommitted.addListener(async details => {
  // Only track the main frame
  if (details.frameId !== 0) return;

  const { tabId, url, transitionType, transitionQualifiers } = details;

  const state = tabState.get(tabId) || {
    url: null,
    lastEventId: null,
    pendingParentEventId: null
  };

  // Determine parent event
  let parentEventId = null;

  if (
    transitionType === 'link' ||
    transitionType === 'form_submit' ||
    transitionType === 'reload'
  ) {
    // Same-tab navigation — parent is the previous page in this tab
    parentEventId = state.lastEventId;
  } else if (state.pendingParentEventId !== null) {
    // New tab opened from another tab (first navigation)
    parentEventId = state.pendingParentEventId;
  }
  // For 'typed', 'auto_bookmark', 'generated', 'start_page' — start a new root
  // (no parent — new navigation tree)

  const event = {
    url,
    title: url, // initial fallback; updated in onCompleted
    timestamp: Date.now(),
    tabId,
    parentEventId,
    transitionType,
    transitionQualifiers
  };

  try {
    const response = await fetch(`${SERVICE_URL}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });

    if (response.status === 201) {
      const data = await response.json();
      tabState.set(tabId, {
        url,
        lastEventId: data.id,
        pendingParentEventId: null
      });
      persistTabState();
    } else if (response.status === 204) {
      // URL was skipped (e.g. chrome://)
      tabState.set(tabId, { url, lastEventId: state.lastEventId, pendingParentEventId: null });
      persistTabState();
    }
  } catch {
    // Service not running — store event in the offline queue
    enqueueOffline(event);
  }
});

// Update event title when the page finishes loading
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.title) return;
  const state = tabState.get(tabId);
  if (!state || state.lastEventId === null) return;

  try {
    await fetch(`${SERVICE_URL}/api/events/${state.lastEventId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: changeInfo.title })
    });
  } catch {
    // Service not running, skip title update
  }
});

// ── Offline queue ──────────────────────────────────────────────────────────
// Events captured while the service is down are queued and retried.

async function enqueueOffline(event) {
  const { offlineQueue = [] } = await chrome.storage.local.get('offlineQueue');
  offlineQueue.push(event);
  // Keep the queue bounded
  const bounded = offlineQueue.slice(-500);
  await chrome.storage.local.set({ offlineQueue: bounded });
}

async function flushOfflineQueue() {
  const { offlineQueue = [] } = await chrome.storage.local.get('offlineQueue');
  if (offlineQueue.length === 0) return;

  const remaining = [];
  for (const event of offlineQueue) {
    try {
      const response = await fetch(`${SERVICE_URL}/api/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event)
      });
      if (!response.ok && response.status !== 204) {
        remaining.push(event);
      }
    } catch {
      remaining.push(event);
      break; // Service still down — stop trying
    }
  }

  await chrome.storage.local.set({ offlineQueue: remaining });
}

// Attempt to flush offline queue every 2 minutes
chrome.alarms.create('flushQueue', { periodInMinutes: 2 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'flushQueue') flushOfflineQueue();
});
