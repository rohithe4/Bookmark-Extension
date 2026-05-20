/**
 * content.js — Content Script for X (Twitter) and Instagram.
 * Intercepts native bookmark clicks, scrapes metadata with lazy-load support, and sends to background.js.
 */

// Local feature settings cache
let settings = {
  enableXBookmarks: true,
  enableInstagram: true,
  showNotifications: true
};

// Retrieve settings on script start
try {
  chrome.storage.local.get(['enableXBookmarks', 'enableInstagram', 'showNotifications'], (data) => {
    if (data.enableXBookmarks !== undefined) settings.enableXBookmarks = data.enableXBookmarks;
    if (data.enableInstagram !== undefined) settings.enableInstagram = data.enableInstagram;
    if (data.showNotifications !== undefined) settings.showNotifications = data.showNotifications;
  });
} catch (e) {}

// Watch for runtime settings changes
try {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
      if (changes.enableXBookmarks !== undefined) settings.enableXBookmarks = changes.enableXBookmarks.newValue;
      if (changes.enableInstagram !== undefined) settings.enableInstagram = changes.enableInstagram.newValue;
      if (changes.showNotifications !== undefined) settings.showNotifications = changes.showNotifications.newValue;
    }
  });
} catch (e) {}

// Debug log helper
const log = (msg, ...args) => console.log(`%c[Notion Bookmark]%c ${msg}`, 'color: #e8e8ed; background: #1f1f23; padding: 2px 6px; border-radius: 4px; font-weight: bold;', '', ...args);
const error = (msg, ...args) => console.error(`%c[Notion Bookmark]%c ${msg}`, 'color: #ff4a4a; background: #1f1f23; padding: 2px 6px; border-radius: 4px; font-weight: bold;', '', ...args);

// Rate-limiting / De-duplication tracker
const savedUrls = new Map();

function isDuplicate(url) {
  const now = Date.now();
  if (savedUrls.has(url)) {
    const lastSaved = savedUrls.get(url);
    if (now - lastSaved < 1500) { // 1.5 second debounce
      return true;
    }
  }
  savedUrls.set(url, now);

  // Periodic cleanup
  if (savedUrls.size > 100) {
    for (const [key, val] of savedUrls.entries()) {
      if (now - val > 5000) {
        savedUrls.delete(key);
      }
    }
  }
  return false;
}

/**
 * Parses srcset to extract the highest resolution image candidate.
 */
function getHighResFromSrcset(srcset) {
  if (!srcset) return null;
  try {
    const candidates = srcset.split(',').map(s => {
      const parts = s.trim().split(/\s+/);
      const url = parts[0];
      const sizeVal = parts[1] ? parseInt(parts[1].replace(/[xw]/g, ''), 10) : 0;
      return { url, size: sizeVal };
    });
    // Sort descending by size to retrieve the highest resolution option
    candidates.sort((a, b) => b.size - a.size);
    return candidates[0] ? candidates[0].url : null;
  } catch (e) {
    return null;
  }
}

// Scrape X (Twitter) Tweet details
function handleXClick(target) {
  // 1. Precise button-level collision filter:
  // If clicked inside a button container, check if it's the bookmark button. If not, ignore immediately.
  const button = target.closest('button, [role="button"]');
  if (button) {
    const testId = button.getAttribute('data-testid') || '';
    const ariaLabel = button.getAttribute('aria-label') || '';
    const isBookmark = testId === 'bookmark' || 
                       testId === 'removeBookmark' || 
                       ariaLabel.toLowerCase().includes('bookmark');

    if (!isBookmark) {
      log('Ignored click on non-bookmark action button.');
      return;
    }
  }

  // 2. Structural target validation
  const bookmarkBtn = target.closest('[data-testid="bookmark"], [data-testid="removeBookmark"], [aria-label*="bookmark" i]');
  
  if (!bookmarkBtn) return;

  log('Detected click on X Bookmark button! Waiting 500ms for lazy load...');

  // Ignore bookmark button clicks if on the X Bookmarks page
  if (window.location.pathname.includes('/bookmarks')) {
    log('Bookmark click ignored: User is on the Bookmarks page (bookmark removal).');
    return;
  }

  // 1. Non-blocking delay to let React fully load the visual cards/images
  setTimeout(() => {
    // Locate closest tweet container
    const tweetEl = bookmarkBtn.closest('article, [data-testid="tweet"]');
    let postUrl = '';
    let title = 'X Post';
    let imageUrl = null;

    if (tweetEl) {
      // Scrape Tweet URL using absolute regex status ID parsing
      const links = tweetEl.querySelectorAll('a');
      for (const link of links) {
        const match = link.href.match(/\/status\/(\d+)/);
        if (match) {
          // Avoid grabbing internal quote tweet links
          if (link.closest('[data-testid="quoteTweet"]')) {
            continue;
          }
          const pathname = link.pathname || '';
          const pathParts = pathname.split('/').filter(Boolean);
          const authorHandle = pathParts[0] || 'x';
          postUrl = `https://x.com/${authorHandle}/status/${match[1]}`;
          break;
        }
      }

      // Scrape Author details
      let username = '@Unknown';
      const userNameEl = tweetEl.querySelector('[data-testid="User-Name"]');
      if (userNameEl) {
        const text = userNameEl.innerText || '';
        const parts = text.split('\n');
        const handlePart = parts.find(p => p.startsWith('@'));
        if (handlePart) {
          username = handlePart;
        } else if (parts[1]) {
          username = parts[1];
        } else if (parts[0]) {
          username = '@' + parts[0].replace(/\s+/g, '');
        }
      }

      // Scrape Tweet Text Content
      const tweetTextEl = tweetEl.querySelector('[data-testid="tweetText"]');
      let tweetText = '';
      if (tweetTextEl) {
        tweetText = tweetTextEl.innerText || tweetTextEl.textContent || '';
      }

      let cleanText = tweetText.trim().replace(/\s+/g, ' ');
      // Extract first line/sentence
      const firstBreak = cleanText.search(/[\n.]/);
      if (firstBreak !== -1) {
        cleanText = cleanText.substring(0, firstBreak).trim();
      }

      if (cleanText.length > 50) {
        cleanText = cleanText.substring(0, 47) + '...';
      }

      title = cleanText ? `${username} - ${cleanText}` : `${username} - X Post`;

      // 2. Scrape high-resolution Tweet Image (prioritizes Tweet photos, card wrappers, and media containers)
      const imgEl = tweetEl.querySelector([
        '[data-testid="tweetPhoto"] img',
        '[data-testid="card.wrapper"] img',
        '[data-testid="card.layoutLarge.media"] img',
        '[data-testid="linkCardSingleImageMedia"] img',
        '[data-testid="mediaContainer"] img'
      ].join(','));

      if (imgEl) {
        const src = imgEl.src || '';
        // Avoid profile avatars
        if (src && !src.includes('/profile_images/')) {
          imageUrl = src;
          log(`Scraped X tweet image URL: ${imageUrl}`);
        }
      }

      // 3. Fallback to user profile avatar if no post image is found
      if (!imageUrl) {
        const avatarEl = tweetEl.querySelector('[data-testid="Tweet-User-Avatar"] img, img[src*="/profile_images/"]');
        if (avatarEl && avatarEl.src) {
          imageUrl = avatarEl.src;
          log(`Using X profile avatar as fallback image: ${imageUrl}`);
        }
      }
    }

    // Fallbacks
    if (!postUrl) {
      postUrl = window.location.href;
      title = `X Post (Fallback: Current Page)`;
      log('Could not find specific tweet URL, using fallback current page URL.');
    }

    sendToNotion(title, postUrl, imageUrl);
  }, 500);
}

// Helper to locate the Instagram Save/Bookmark button robustly
function findInstagramSaveButton(target) {
  if (!target) return null;

  // 1. Direct match on the target or its ancestors having the aria-label
  const directBtn = target.closest([
    '[aria-label*="save" i]',
    '[aria-label*="remove" i]',
    '[aria-label*="bookmark" i]',
    'svg[aria-label*="save" i]',
    'svg[aria-label*="remove" i]'
  ].join(','));
  if (directBtn) return directBtn;

  // 2. If clicked on a button or div[role="button"] container, check if it contains a Save/Remove SVG
  const container = target.closest('button, [role="button"]');
  if (container) {
    const svg = container.querySelector([
      'svg[aria-label*="save" i]',
      'svg[aria-label*="remove" i]',
      'svg[aria-label*="bookmark" i]'
    ].join(','));
    if (svg) return container;
  }

  // 3. Check if target itself has a child matching SVG
  const childSvg = target.querySelector([
    'svg[aria-label*="save" i]',
    'svg[aria-label*="remove" i]',
    'svg[aria-label*="bookmark" i]'
  ].join(','));
  if (childSvg) return target;

  return null;
}

// Helper to determine if a clicked bookmark button is a removal action (unsave/remove/saved)
function isInstagramRemoveClick(btn) {
  if (!btn) return false;

  const isRemoveLabel = (label) => {
    if (!label) return false;
    const l = label.toLowerCase();
    return l.includes('remove') || l.includes('unsave') || l.includes('saved');
  };

  // Check the button itself
  if (isRemoveLabel(btn.getAttribute('aria-label'))) {
    return true;
  }

  // Check child SVGs
  const svg = btn.querySelector('svg');
  if (svg && isRemoveLabel(svg.getAttribute('aria-label'))) {
    return true;
  }

  return false;
}

// Scrape Instagram Post details
function handleInstagramClick(target) {
  // Find closest Instagram Save button
  const igBtn = findInstagramSaveButton(target);
  if (!igBtn) return;

  // Ignore bookmark removal actions
  if (isInstagramRemoveClick(igBtn)) {
    log('Ignored click: Instagram bookmark removal action detected.');
    return;
  }

  log('Detected click on Instagram Bookmark button! Resolving post details synchronously...');

  // Resolve post element and URLs immediately while the button is guaranteed to be in the DOM
  let postEl = igBtn.closest('article');
  if (!postEl) {
    let temp = igBtn.parentElement;
    while (temp && temp !== document.body) {
      const hasLink = temp.querySelector('a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"], a[href*="/tv/"]');
      if (hasLink) {
        postEl = temp;
        break;
      }
      temp = temp.parentElement;
    }
  }

  let postUrl = '';
  let author = '';

  if (postEl) {
    // Scrape Post/Reel URL synchronously
    const links = postEl.querySelectorAll('a');
    for (const link of links) {
      if (link.href && (link.href.includes('/p/') || link.href.includes('/reel/') || link.href.includes('/reels/') || link.href.includes('/tv/'))) {
        try {
          const urlObj = new URL(link.href);
          postUrl = urlObj.origin + urlObj.pathname;
          break;
        } catch (e) {}
      }
    }

    // Scrape Author / Username synchronously
    const headerLinks = postEl.querySelectorAll('header a, a[role="link"]');
    for (const link of headerLinks) {
      const href = link.getAttribute('href');
      if (href && href.startsWith('/') && href.length > 2) {
        const parts = href.split('/').filter(Boolean);
        if (parts.length === 1) { // Single username segment
          author = parts[0];
          break;
        }
      }
    }
  }

  // Fallback for postUrl
  if (!postUrl) {
    // If we are on a single post page, use window.location.href
    if (window.location.pathname.includes('/p/') || window.location.pathname.includes('/reel/') || window.location.pathname.includes('/reels/') || window.location.pathname.includes('/tv/')) {
      postUrl = window.location.origin + window.location.pathname;
    } else {
      postUrl = window.location.href;
    }
  }

  // Format title
  let title = author ? `${author} Instagram Post` : 'Instagram Post';

  log(`Synchronously resolved: Title="${title}", URL="${postUrl}". Waiting 500ms for high-res image lazy load...`);

  // 1. Non-blocking delay to let Instagram swap out placeholder blobs with JPEG links
  setTimeout(() => {
    let imageUrl = null;

    if (postEl) {
      const imgEl = postEl.querySelector('[role="button"] > div > div[role="presentation"] img, div[style*="padding-bottom"] img, img[srcset]');
      if (imgEl) {
        let src = imgEl.src || '';
        const srcset = imgEl.getAttribute('srcset') || imgEl.srcset || '';

        // If it uses srcset, extract the highest resolution clean JPG url
        if (srcset) {
          const highResCandidate = getHighResFromSrcset(srcset);
          if (highResCandidate) {
            src = highResCandidate;
          }
        }

        // Avoid local dynamic blob: caching URLs
        if (src && !src.startsWith('blob:')) {
          imageUrl = src;
          log(`Scraped Instagram high-res post image URL: ${imageUrl}`);
        }
      }

      // 2. Fallback to user profile avatar if no post image is found
      if (!imageUrl) {
        const avatarEl = postEl.querySelector('header img, img[src*="/t51.2885-19/"], canvas + img, [style*="canvas"] + img');
        if (avatarEl && avatarEl.src && !avatarEl.src.startsWith('blob:')) {
          imageUrl = avatarEl.src;
          log(`Using Instagram profile avatar as fallback image: ${imageUrl}`);
        }
      }
    }

    sendToNotion(title, postUrl, imageUrl);
  }, 500);
}

// Helper to trigger inline toast notifications
function showToast(message, isError = false) {
  if (!settings.showNotifications) {
    return; // Bypass toasts if notifications are disabled
  }
  let toast = document.getElementById('notion-bookmark-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'notion-bookmark-toast';
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: #1e1e24;
      color: #f4f4f6;
      padding: 10px 18px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      z-index: 999999;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.08);
      transition: opacity 0.25s cubic-bezier(0.4, 0, 0.2, 1), transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      pointer-events: none;
      opacity: 0;
      transform: translateX(-50%) translateY(8px);
    `;
    document.body.appendChild(toast);
  }

  toast.style.borderColor = isError ? 'rgba(239, 68, 68, 0.3)' : 'rgba(255, 255, 255, 0.08)';
  toast.textContent = message;
  
  // Animate in
  toast.style.opacity = '1';
  toast.style.transform = 'translateX(-50%) translateY(0)';

  // Animate out
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(8px)';
  }, 2500);
}

// Send scraped data to background worker
function sendToNotion(title, url, imageUrl = null) {
  // Strip trailing slashes and query params for de-duplication normalization
  const cleanUrl = url.split('?')[0].replace(/\/$/, '');

  if (isDuplicate(cleanUrl)) {
    log(`De-duplicated save request for: ${cleanUrl}`);
    return;
  }

  const isX = window.location.hostname.includes('x.com') || window.location.hostname.includes('twitter.com');
  const action = isX ? APP_CONFIG.ACTIONS.SAVE_X_BOOKMARK : APP_CONFIG.ACTIONS.SAVE_TO_NOTION;

  log(`Sending to Notion [${action}]: "${title}" -> ${cleanUrl} (Image: ${imageUrl})`);

  chrome.runtime.sendMessage({
    action: action,
    title: title,
    url: cleanUrl,
    imageUrl: imageUrl
  }, (response) => {
    if (chrome.runtime.lastError) {
      error(`Runtime error sending message: ${chrome.runtime.lastError.message}`);
      showToast('Extension error saving post', true);
      return;
    }
    
    if (response && response.success) {
      if (response.alreadyExists) {
        log(`Deduplication success: ${cleanUrl} already bookmarked.`);
        showToast('Already saved to Notion!');
      } else {
        log(`✅ Successfully saved to Notion!`);
        showToast('Saved to Notion! 📌');
      }
    } else {
      error(`❌ Failed to save to Notion:`, response?.error || 'Unknown background error');
      showToast('Error saving to Notion database', true);
    }
  });
}

// Single delegating event listener for robustness (registered at the absolute document root)
document.addEventListener('click', (event) => {
  const host = window.location.hostname;
  const isX = host.includes('x.com') || host.includes('twitter.com');
  const isInstagram = host.includes('instagram.com');

  if (!isX && !isInstagram) return;
  if (isX && !settings.enableXBookmarks) return;
  if (isInstagram && !settings.enableInstagram) return;

  const target = event.target;
  if (!target) return;

  log(`Delegated click captured | Host: ${host} | Target:`, target);

  if (isX) {
    handleXClick(target);
  } else if (isInstagram) {
    handleInstagramClick(target);
  }
}, true); // Use capture phase to catch events before they get cancelled by other handlers

log('Content script successfully loaded and listening for lazy-loaded bookmark clicks on X & Instagram.');
