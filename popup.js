/**
 * popup.js — UI controller for the Notion Bookmark extension.
 *
 * Handles:
 * 1. Fetching active tab metadata on popup open.
 * 2. Sending tab data to the background service worker via chrome.runtime.sendMessage.
 * 3. Managing button loading/success/error states.
 * 4. Fetching, filtering, and displaying recently saved bookmarks.
 */

const DOM = {
  tabTitle:           document.getElementById('tabTitle'),
  tabUrl:             document.getElementById('tabUrl'),
  saveBtn:            document.getElementById('saveBtn'),
  btnText:            document.getElementById('btnText'),
  status:             document.getElementById('status'),
  statusIcon:         document.getElementById('statusIcon'),
  statusText:         document.getElementById('statusText'),
  bookmarksList:      document.getElementById('bookmarksList'),
  settingsBtn:        document.getElementById('settingsBtn'),
  notConfiguredBanner:document.getElementById('notConfiguredBanner'),
  setupBtn:           document.getElementById('setupBtn'),
  tabsHeader:         document.getElementById('tabsHeader'),
};

/* Short display labels for tab buttons */
const TAB_LABELS = {
  'X / Twitter': 'X',
  'General web pages': 'Web',
};

let currentTab = null;
let allBookmarks = [];
let activeCategory = 'all';
let isConfigured = false;

/* ── UI Helpers ───────────────────────────────────── */

function setLoading(isLoading) {
  DOM.saveBtn.disabled = isLoading;
  DOM.btnText.textContent = isLoading ? 'Saving…' : 'Save to Notion';

  const existingSpinner = DOM.saveBtn.querySelector('.spinner');
  if (isLoading && !existingSpinner) {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    DOM.saveBtn.prepend(spinner);
  } else if (!isLoading && existingSpinner) {
    existingSpinner.remove();
  }
}

function showStatus(type, message) {
  DOM.status.className = `status visible ${type}`;
  DOM.statusIcon.textContent = type === 'success' ? '✓' : '✕';
  DOM.statusText.textContent = message;
}

function hideStatus() {
  DOM.status.className = 'status';
}

function getSourceClass(source) {
  if (source === 'X / Twitter') return 'x-twitter';
  if (source === 'YouTube') return 'youtube';
  if (source === 'Instagram') return 'instagram';
  if (source === 'Reddit') return 'reddit';
  if (source === 'LinkedIn') return 'linkedin';
  return 'website';
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

/* ── Fetch Bookmarks from Background ─────────────── */

async function fetchBookmarks() {
  if (!isConfigured) {
    DOM.bookmarksList.innerHTML = `<div class="list-message">Complete setup to view recently saved bookmarks.</div>`;
    return;
  }

  // Show skeletons during loading
  DOM.bookmarksList.innerHTML = `
    <div class="skeleton-item"><div class="skeleton-line short"></div><div class="skeleton-line long"></div></div>
    <div class="skeleton-item"><div class="skeleton-line short"></div><div class="skeleton-line long"></div></div>
    <div class="skeleton-item"><div class="skeleton-line short"></div><div class="skeleton-line long"></div></div>
  `;

  try {
    const response = await chrome.runtime.sendMessage({ action: 'GET_BOOKMARKS' });
    if (response?.success) {
      allBookmarks = response.bookmarks || [];
      renderBookmarks();
    } else {
      const errMsg = response?.error || 'Unknown error querying database.';
      DOM.bookmarksList.innerHTML = `<div class="list-message error">Failed to load bookmarks: ${errMsg}</div>`;
    }
  } catch (err) {
    DOM.bookmarksList.innerHTML = `<div class="list-message error">Connection error: ${err.message}</div>`;
    console.error('[popup] fetchBookmarks error:', err);
  }
}

/* ── Render Bookmarks List ───────────────────────── */

function renderBookmarks() {
  const filtered = activeCategory === 'all'
    ? allBookmarks
    : allBookmarks.filter(b => b.source === activeCategory);

  if (filtered.length === 0) {
    DOM.bookmarksList.innerHTML = `<div class="list-message">No bookmarks under "${activeCategory}" yet.</div>`;
    return;
  }

  DOM.bookmarksList.innerHTML = filtered.map(b => {
    const sourceClass = getSourceClass(b.source);
    let displayUrl = b.url;
    try {
      const u = new URL(b.url);
      displayUrl = u.hostname + u.pathname;
    } catch (e) {}

    const deleteBtn = b.id 
      ? `<button class="delete-btn" data-id="${escapeHTML(b.id)}" title="Delete Bookmark">✕</button>`
      : '';

    return `
      <div class="bookmark-item" data-url="${escapeHTML(b.url)}">
        ${deleteBtn}
        <div class="bookmark-meta">
          <span class="source-tag ${sourceClass}">${escapeHTML(b.source)}</span>
          <span class="bookmark-time">${formatDate(b.createdTime)}</span>
        </div>
        <div class="bookmark-title">${escapeHTML(b.title)}</div>
        <div class="bookmark-url">${escapeHTML(displayUrl)}</div>
      </div>
    `;
  }).join('');

  // Add click handler to cards to open bookmark URLs in a new browser tab
  DOM.bookmarksList.querySelectorAll('.bookmark-item').forEach(card => {
    card.addEventListener('click', () => {
      const url = card.getAttribute('data-url');
      if (url) {
        chrome.tabs.create({ url: url });
      }
    });
  });

  // Add click handler to delete buttons
  DOM.bookmarksList.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation(); // Stop opening the tab
      
      const pageId = btn.getAttribute('data-id');
      if (!pageId) return;

      if (confirm('Delete this bookmark from Notion?')) {
        const card = btn.closest('.bookmark-item');
        if (card) {
          card.style.opacity = '0.5';
          card.style.pointerEvents = 'none';
        }

        try {
          const response = await chrome.runtime.sendMessage({
            action: 'DELETE_BOOKMARK',
            pageId: pageId
          });

          if (response?.success) {
            showStatus('success', 'Bookmark deleted!');
            if (card) {
              card.style.transition = 'all 300ms cubic-bezier(0.4, 0, 0.2, 1)';
              card.style.transform = 'scale(0.9) translateY(4px)';
              card.style.opacity = '0';
              setTimeout(() => {
                allBookmarks = allBookmarks.filter(item => item.id !== pageId);
                renderBookmarks();
              }, 300);
            }
          } else {
            showStatus('error', response?.error || 'Failed to delete bookmark.');
            if (card) {
              card.style.opacity = '1';
              card.style.pointerEvents = 'auto';
            }
          }
        } catch (err) {
          showStatus('error', `Connection error: ${err.message}`);
          if (card) {
            card.style.opacity = '1';
            card.style.pointerEvents = 'auto';
          }
        }
      }
    });
  });
}

/* ── Initialize: Get active tab info ─────────────── */

async function init() {
  // Check if Notion is configured; show warning banner if not
  try {
    const data = await chrome.storage.local.get(['notionApiKey', 'notionDatabaseId', 'enabledSources']);
    isConfigured = !!(data.notionApiKey && data.notionDatabaseId);
    if (!isConfigured) {
      DOM.notConfiguredBanner.classList.add('visible');
      DOM.saveBtn.disabled = true;
      DOM.btnText.textContent = 'Setup required';
    }
    // Build dynamic source filter tabs
    buildSourceTabs(data.enabledSources);
  } catch (e) { /* storage unavailable */ }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      DOM.tabTitle.textContent = 'No active tab found';
      DOM.saveBtn.disabled = true;
      return;
    }

    currentTab = { title: tab.title || 'Untitled', url: tab.url || '' };
    DOM.tabTitle.textContent = currentTab.title;
    DOM.tabUrl.textContent = currentTab.url;
  } catch (err) {
    DOM.tabTitle.textContent = 'Unable to read tab';
    DOM.saveBtn.disabled = true;
    console.error('[popup] init error:', err);
  }

  // Fetch Notion bookmarks list on open
  fetchBookmarks();
}

/* ── Save handler ────────────────────────────────── */

async function handleSave() {
  if (!currentTab) return;

  hideStatus();
  setLoading(true);

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'SAVE_TO_NOTION',
      data: {
        title: currentTab.title,
        url: currentTab.url,
      },
    });

    if (response?.success) {
      showStatus('success', 'Saved to Notion!');
      DOM.saveBtn.disabled = true;
      DOM.btnText.textContent = 'Saved ✓';
      
      // Refresh the list immediately to show the newly added bookmark!
      setTimeout(fetchBookmarks, 400);
    } else {
      const errMsg = response?.error || 'Unknown error occurred.';
      showStatus('error', errMsg);
      setLoading(false);
    }
  } catch (err) {
    showStatus('error', `Extension error: ${err.message}`);
    setLoading(false);
    console.error('[popup] save error:', err);
  }
}

/* ── Event listeners ─────────────────────────────── */

DOM.saveBtn.addEventListener('click', handleSave);

// Settings gear — opens the options/onboarding page
DOM.settingsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// Setup banner CTA
DOM.setupBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// Allow Enter key to trigger save from anywhere in the popup
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !DOM.saveBtn.disabled) {
    handleSave();
  }
});

/**
 * Dynamically builds source filter tabs based on user's enabled sources.
 */
function buildSourceTabs(enabledSources) {
  const sources = enabledSources || ['X / Twitter', 'Instagram', 'YouTube', 'Reddit', 'LinkedIn', 'General web pages'];

  // Clear existing tabs (keep the "All" button)
  DOM.tabsHeader.innerHTML = '';

  // Always add "All" first
  const allBtn = document.createElement('button');
  allBtn.className = 'tab-btn active';
  allBtn.setAttribute('data-source', 'all');
  allBtn.textContent = 'All';
  DOM.tabsHeader.appendChild(allBtn);

  // Add a tab for each enabled source
  sources.forEach(source => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.setAttribute('data-source', source);
    btn.textContent = TAB_LABELS[source] || source;
    DOM.tabsHeader.appendChild(btn);
  });

  // Bind click listeners to all tabs
  bindTabListeners();
}

function bindTabListeners() {
  DOM.tabsHeader.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      DOM.tabsHeader.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeCategory = btn.getAttribute('data-source');
      renderBookmarks();
    });
  });
}

/* ── Boot ─────────────────────────────────────────── */
init();
