/**
 * background.js — Manifest V3 Service Worker.
 *
 * Handles the Notion API call server-side to bypass CORS restrictions
 * that would block requests from popup.js.
 *
 * Credentials are stored securely in chrome.storage.local and never
 * exposed to content scripts.
 */

'use strict';

importScripts('constants.js');

const NOTION_API_URL = 'https://api.notion.com/v1/pages';
const NOTION_VERSION = APP_CONFIG.NOTION_API_VERSION;

/**
 * Loads Notion credentials from chrome.storage.local.
 * Returns null values if not configured.
 */
async function getCredentials() {
  try {
    const data = await chrome.storage.local.get(['notionApiKey', 'notionDatabaseId', 'sourcePropertyType']);
    return {
      token: data.notionApiKey || null,
      databaseId: data.notionDatabaseId || null,
      sourcePropertyType: data.sourcePropertyType || 'multi_select'
    };
  } catch (e) {
    return { token: null, databaseId: null, sourcePropertyType: 'multi_select' };
  }
}

/**
 * Automatically determines the category/source name based on URL hostnames.
 */
function getSourceFromUrl(url) {
  if (!url) return APP_CONFIG.SOURCE_LABELS.GENERAL;
  try {
    const domain = new URL(url).hostname.toLowerCase();
    if (domain.includes('youtube.com') || domain.includes('youtu.be')) {
      return APP_CONFIG.SOURCE_LABELS.YOUTUBE;
    }
    if (domain.includes('x.com') || domain.includes('twitter.com')) {
      return APP_CONFIG.SOURCE_LABELS.X;
    }
    if (domain.includes('instagram.com')) {
      return APP_CONFIG.SOURCE_LABELS.INSTAGRAM;
    }
    if (domain.includes('reddit.com')) {
      return APP_CONFIG.SOURCE_LABELS.REDDIT;
    }
    if (domain.includes('linkedin.com')) {
      return APP_CONFIG.SOURCE_LABELS.LINKEDIN;
    }
  } catch (e) {}
  return APP_CONFIG.SOURCE_LABELS.GENERAL;
}

/**
 * Decodes standard HTML entities (like &amp; or &quot;) inside a string.
 */
function decodeHTMLEntities(str) {
  if (!str) return '';
  const entities = {
    'amp': '&',
    'lt': '<',
    'gt': '>',
    'quot': '"',
    'apos': "'",
    '#39': "'",
    '#x27': "'",
    '#47': '/',
    '#x2F': '/'
  };
  return str.replace(/&(#?[a-zA-Z0-9]+);/g, (match, entity) => {
    return entities[entity.toLowerCase()] || match;
  });
}

function isGenericTitle(title) {
  if (!title) return true;
  const genericPlaceholders = [
    'Saved YouTube Video',
    'Saved X Tweet',
    'Saved Instagram Post',
    'Saved Link',
    'Untitled',
    'YouTube',
    'X',
    'Twitter',
    'Instagram',
    'X Post',
    'Instagram Post',
    'X (Twitter)',
    'X Post (Fallback: Current Page)',
    'Instagram Post (Fallback: Current Page)'
  ];
  const cleanTitle = title.trim();
  if (cleanTitle.startsWith('http://') || cleanTitle.startsWith('https://')) return true;
  return genericPlaceholders.some(placeholder => cleanTitle.toLowerCase() === placeholder.toLowerCase());
}

/**
 * Extracts the author from an Instagram title or URL, completely ignoring the caption,
 * and formats it strictly as "[Author] Instagram Post".
 */
function formatInstagramTitle(title, url) {
  let author = '';

  if (title) {
    // E.g., "Headspace on Instagram: ..." or "Headspace on Instagram"
    const match1 = title.match(/^(.*?)\s+on\s+Instagram/i);
    if (match1 && match1[1]) {
      author = match1[1].trim();
    } else {
      // E.g., "Headspace (@headspace) • Instagram..."
      const match2 = title.match(/^(.*?)\s+\(@/i);
      if (match2 && match2[1]) {
        author = match2[1].trim();
      } else {
        // E.g., "Instagram post by Headspace..."
        const match3 = title.match(/Instagram post by (.*?) •/i);
        if (match3 && match3[1]) {
          author = match3[1].trim();
        } else {
          // If the title is already formatted as "Author Instagram Post"
          const match4 = title.match(/^(.*?)\s+Instagram\s+Post$/i);
          if (match4 && match4[1]) {
            author = match4[1].trim();
          }
        }
      }
    }
  }

  if (author) {
    author = author.replace(/^@/, '').trim();
  }

  // If no author found from title, try to get username from URL (if it's a profile URL like instagram.com/username)
  if (!author && url) {
    try {
      const parsedUrl = new URL(url);
      const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
      if (pathParts.length === 1 && !['p', 'reel', 'reels', 'tv', 'stories', 'explore'].includes(pathParts[0])) {
        author = pathParts[0];
      }
    } catch (e) {}
  }

  if (author) {
    return `${author} Instagram Post`;
  }
  return 'Instagram Post';
}

/**
 * Extracts specific meta tags from HTML body supporting flex layout attributes.
 */
function extractMetaTag(htmlText, propertyOrName) {
  const escapedProp = propertyOrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escapedProp}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escapedProp}["']`, 'i'),
  ];
  
  for (const pattern of patterns) {
    const match = htmlText.match(pattern);
    if (match && match[1]) return decodeHTMLEntities(match[1].trim());
  }
  return null;
}

/**
 * Last-resort fallback for video page thumbnail extraction.
 */
function extractThumbnailFromVideoTag(html) {
  // Try to find poster attribute on video tags
  const videoPosterMatch = html.match(/<video[^>]+poster=["']([^"']+)["']/i);
  if (videoPosterMatch && videoPosterMatch[1]) return videoPosterMatch[1];
  
  // Try to find thumbnail in JSON-LD structured data
  const jsonLdMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>(.*?)<\/script>/is);
  if (jsonLdMatch && jsonLdMatch[1]) {
    try {
      const cleanJson = jsonLdMatch[1].trim();
      const data = JSON.parse(cleanJson);
      if (data.thumbnailUrl) return data.thumbnailUrl;
      if (data.image?.url) return data.image.url;
      if (Array.isArray(data.image) && data.image[0]) return data.image[0];
      if (typeof data.image === 'string') return data.image;
    } catch (e) {
      // Invalid JSON, skip
    }
  }
  return null;
}

/**
 * Fetches the URL and extracts its Open Graph title (og:title) or standard HTML <title>,
 * as well as its cover image. Falls back to a CORS proxy if direct fetch is blocked.
 */
async function fetchMetadata(url) {
  let html = '';
  let fetchedOk = false;

  // 1. Try direct fetch first
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (res.ok) {
      html = await res.text();
      fetchedOk = true;
    }
  } catch (err) {
    console.warn('[background] Direct fetch failed. Retrying with proxy fallback...');
  }

  // 2. Try proxy fallbacks if direct fetch failed
  if (!fetchedOk) {
    const proxies = [
      `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
      `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
    ];

    for (const proxyUrl of proxies) {
      try {
        console.log(`[background] Retrying fetch via proxy: ${proxyUrl}`);
        const res = await fetch(proxyUrl);
        if (res.ok) {
          html = await res.text();
          fetchedOk = true;
          console.log('[background] Proxy fetch succeeded!');
          break;
        }
      } catch (proxyErr) {
        console.warn(`[background] Proxy fetch failed: ${proxyUrl}`, proxyErr.message);
      }
    }
  }

  if (!fetchedOk || !html) return null;

  try {
    // 1. Extract Title
    let title = '';
    const ogMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
                    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);

    if (ogMatch && ogMatch[1]) {
      title = decodeHTMLEntities(ogMatch[1].trim());
    } else {
      const standardMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (standardMatch && standardMatch[1]) {
        title = decodeHTMLEntities(standardMatch[1].trim());
      }
    }

    // 2. Extract og:image / video thumbnail with extensive fallbacks
    let rawImageUrl = 
      extractMetaTag(html, 'og:image') ||
      extractMetaTag(html, 'og:image:url') ||
      extractMetaTag(html, 'og:image:secure_url') ||
      extractMetaTag(html, 'twitter:player:image') ||
      extractMetaTag(html, 'twitter:image') ||
      extractMetaTag(html, 'twitter:image:src') ||
      extractMetaTag(html, 'og:video:secure_url') ||
      extractMetaTag(html, 'twitter:player:stream') ||
      extractMetaTag(html, 'og:video:thumbnail') ||
      extractMetaTag(html, 'thumbnail') ||
      extractThumbnailFromVideoTag(html);

    let imageUrl = null;
    if (rawImageUrl) {
      try {
        imageUrl = new URL(rawImageUrl.trim(), url).href;
      } catch (e) {
        imageUrl = rawImageUrl.trim();
      }
    }

    return { title: title || null, imageUrl: imageUrl };
  } catch (err) {
    console.error('[background] Error parsing HTML metadata:', err.message);
  }
  return null;
}

/**
 * Checks if a bookmark URL already exists in the Notion database.
 * @param {string} url - The clean post URL.
 * @returns {Promise<boolean>} - True if it exists, false otherwise.
 */
async function checkIfUrlExists(url, token, databaseId) {
  const queryUrl = `https://api.notion.com/v1/databases/${databaseId}/query`;
  const body = {
    filter: { property: APP_CONFIG.NOTION_PROPERTIES.URL, url: { equals: url } },
    page_size: 1
  };

  try {
    const res = await fetch(queryUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) return false;
    const data = await res.json();
    return data.results && data.results.length > 0;
  } catch (err) {
    return false;
  }
}

/**
 * Validates whether an image URL is valid and supported.
 * Only accepts https URLs, rejecting empty strings, data: URLs, and blob: URLs.
 */
function isValidImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const cleanUrl = url.trim().toLowerCase();
  return cleanUrl.startsWith('https://') && !cleanUrl.startsWith('blob:') && !cleanUrl.startsWith('data:');
}

/**
 * Resolves a preview image for X (Twitter) posts using an API-first approach.
 * @param {string} url - The URL to extract image for.
 * @param {string|null} existingImage - The existing image URL from the content script.
 * @returns {Promise<string|null>} - The valid preview image URL or null.
 */
async function getXPreviewImage(url, existingImage) {
  // If the existing image is valid, use it
  if (isValidImageUrl(existingImage)) {
    console.log(`[background] getXPreviewImage: Using valid existing image: ${existingImage}`);
    return existingImage;
  }

  if (!url) return null;

  const isX = url.includes('x.com') || url.includes('twitter.com');
  if (!isX) return null;

  try {
    const match = url.match(/\/status\/(\d+)/);
    if (match && match[1]) {
      const tweetId = match[1];
      console.log(`[background] getXPreviewImage: Fetching X Tweet via Syndication API for ID: ${tweetId}`);
      const apiRes = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}`);
      if (apiRes.ok) {
        const data = await apiRes.json();
        console.log(`[background] getXPreviewImage response:`, JSON.stringify(data));
        
        let candidate = null;

        // 1. Check mediaDetails image
        if (data?.mediaDetails?.[0]?.media_url_https) {
          candidate = data.mediaDetails[0].media_url_https;
        }

        // 2. Check photos image
        if (!candidate && data?.photos?.[0]?.url) {
          candidate = data.photos[0].url;
        }

        // 3. Check video poster
        if (!candidate && data?.video?.poster) {
          candidate = data.video.poster;
        }

        // 4. Check video variants (only mp4, not m3u8)
        if (!candidate && data?.video?.variants) {
          const mp4Variant = data.video.variants.find(v => 
            v?.url && 
            v.url.toLowerCase().includes('.mp4') && 
            !v.url.toLowerCase().includes('.m3u8')
          );
          if (mp4Variant) {
            candidate = mp4Variant.url;
          }
        }

        // 5. Fallback to user profile image
        if (!candidate && data?.user?.profile_image_url_https) {
          let userImg = data.user.profile_image_url_https;
          if (userImg.includes('_normal.')) {
            userImg = userImg.replace('_normal.', '_400x400.');
          }
          candidate = userImg;
        }

        if (isValidImageUrl(candidate)) {
          console.log(`[background] getXPreviewImage: Found image via X Syndication API: ${candidate}`);
          return candidate;
        }
      }
    }
  } catch (e) {
    console.warn('[background] getXPreviewImage failed:', e.message);
  }

  return null;
}

/**
 * Creates a Notion page in the target database.
 * @param {string} title — Page title (from tab).
 * @param {string} url   — Page URL (from tab).
 * @param {number|null} tabId — Optional active tab ID.
 * @param {string|null} initialImageUrl — Optional pre-scraped image URL from content script.
 * @returns {Promise<{success: boolean, error?: string, alreadyExists?: boolean}>}
 */
async function saveToNotion(title, url, tabId = null, initialImageUrl = null) {
  const { token, databaseId, sourcePropertyType } = await getCredentials();

  if (!token || !databaseId) {
    return { success: false, error: 'Notion is not configured. Please open the extension settings and complete setup.' };
  }

  // Deduplicate before saving
  const exists = await checkIfUrlExists(url, token, databaseId);
  if (exists) {
    return { success: true, alreadyExists: true };
  }

  let finalTitle = title;
  let imageUrl = initialImageUrl || null;

  // 1. Resolve preview image for X posts
  const isX = url && (url.includes('x.com') || url.includes('twitter.com'));
  if (isX) {
    imageUrl = await getXPreviewImage(url, initialImageUrl);
  }

  // 2. Fetch Open Graph metadata if needed
  if (!isValidImageUrl(imageUrl) || isGenericTitle(title)) {
    const meta = await fetchMetadata(url);
    if (meta) {
      if (meta.title && isGenericTitle(title)) finalTitle = meta.title;
      if (meta.imageUrl && !isValidImageUrl(imageUrl)) imageUrl = meta.imageUrl;
    }
  }

  // 3. Instagram title formatting
  if (url && url.includes('instagram.com')) {
    finalTitle = formatInstagramTitle(finalTitle, url);
  }

  const sourceName = getSourceFromUrl(url);

  const body = {
    parent: { database_id: databaseId },
    properties: {
      [APP_CONFIG.NOTION_PROPERTIES.TITLE]: { title: [{ text: { content: finalTitle } }] },
      [APP_CONFIG.NOTION_PROPERTIES.URL]: { url: url }
    },
  };

  if (sourcePropertyType === 'select') {
    body.properties[APP_CONFIG.NOTION_PROPERTIES.SOURCE] = { select: { name: sourceName } };
  } else {
    body.properties[APP_CONFIG.NOTION_PROPERTIES.SOURCE] = { multi_select: [{ name: sourceName }] };
  }

  if (imageUrl) {
    body.cover = { type: 'external', external: { url: imageUrl } };
  }

  try {
    const res = await fetch(NOTION_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      return { success: false, error: errorData.message || `Notion API returned ${res.status}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: `Network error: ${err.message}` };
  }
}

/**
 * Queries the Notion database for the most recently saved bookmarks.
 * @returns {Promise<{success: boolean, bookmarks?: Array, error?: string}>}
 */
async function getBookmarks() {
  const { token, databaseId } = await getCredentials();

  if (!token || !databaseId) {
    return { success: false, error: 'Not configured. Please complete setup in the extension settings.' };
  }

  const queryUrl = `https://api.notion.com/v1/databases/${databaseId}/query`;
  const body = {
    sorts: [{ timestamp: 'created_time', direction: 'descending' }],
    page_size: 30
  };

  try {
    const res = await fetch(queryUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      return { success: false, error: errorData.message || `Notion API returned ${res.status}` };
    }

    const data = await res.json();
    const bookmarks = (data.results || []).map(page => {
      const titleProp = page.properties?.[APP_CONFIG.NOTION_PROPERTIES.TITLE]?.title || [];
      const title = titleProp.map(t => t.plain_text).join('') || 'Untitled';
      const url = page.properties?.[APP_CONFIG.NOTION_PROPERTIES.URL]?.url || '';
      let source = APP_CONFIG.SOURCE_LABELS.GENERAL;
      if (page.properties?.[APP_CONFIG.NOTION_PROPERTIES.SOURCE]) {
        const sourcePropObj = page.properties[APP_CONFIG.NOTION_PROPERTIES.SOURCE];
        if (sourcePropObj.type === 'select') {
          source = sourcePropObj.select?.name || APP_CONFIG.SOURCE_LABELS.GENERAL;
        } else if (sourcePropObj.type === 'multi_select') {
          const sourceProp = sourcePropObj.multi_select || [];
          source = sourceProp[0]?.name || APP_CONFIG.SOURCE_LABELS.GENERAL;
        }
      }
      return { id: page.id, title, url, source, createdTime: page.created_time };
    });

    return { success: true, bookmarks };
  } catch (err) {
    return { success: false, error: `Network error: ${err.message}` };
  }
}

/**
 * Archives (deletes) a bookmark page in Notion.
 * @param {string} pageId — The Notion page ID.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function deleteBookmark(pageId) {
  const { token } = await getCredentials();
  if (!token) return { success: false, error: 'Not configured.' };

  const url = `https://api.notion.com/v1/pages/${pageId}`;
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ archived: true }),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      return { success: false, error: errorData.message || `Notion API returned ${res.status}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: `Network error: ${err.message}` };
  }
}

/* ── Message listener ────────────────────────────── */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  /* ── Save bookmark ── */
  if (message.action === APP_CONFIG.ACTIONS.SAVE_TO_NOTION) {
    const title    = message.data?.title    || message.title;
    const url      = message.data?.url      || message.url;
    const imageUrl = message.data?.imageUrl || message.imageUrl || null;

    if (!title || !url) {
      sendResponse({ success: false, error: 'Missing title or url properties.' });
      return false;
    }

    const tabId = sender.tab ? sender.tab.id : null;
    if (tabId) {
      saveToNotion(title, url, tabId, imageUrl).then(sendResponse);
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTabId = tabs[0]?.id || null;
        saveToNotion(title, url, activeTabId, imageUrl).then(sendResponse);
      });
    }
    return true;
  }

  /* ── Get bookmarks list ── */
  if (message.action === APP_CONFIG.ACTIONS.GET_BOOKMARKS) {
    getBookmarks().then(sendResponse);
    return true;
  }

  /* ── Delete bookmark ── */
  if (message.action === APP_CONFIG.ACTIONS.DELETE_BOOKMARK) {
    deleteBookmark(message.pageId).then(sendResponse);
    return true;
  }

  /* ── Save X/Twitter bookmark (from content script) ── */
  if (message.action === APP_CONFIG.ACTIONS.SAVE_X_BOOKMARK) {
    const title    = message.title;
    const url      = message.url;
    const imageUrl = message.imageUrl || null;
    const tabId    = sender.tab ? sender.tab.id : null;

    if (!title || !url) {
      sendResponse({ success: false, error: 'Missing title or url properties.' });
      return false;
    }
    saveToNotion(title, url, tabId, imageUrl).then(sendResponse);
    return true;
  }

  /* ── Test Notion connection (from options page) ── */
  if (message.action === APP_CONFIG.ACTIONS.TEST_NOTION_CONNECTION) {
    const { apiKey, databaseId, selectedSources } = message;
    if (!apiKey || !databaseId) {
      sendResponse({ success: false, error: 'Missing apiKey or databaseId.' });
      return false;
    }
    testNotionConnection(apiKey, databaseId, selectedSources || []).then(sendResponse);
    return true;
  }

  /* ── Reload settings signal (no-op; credentials are fetched fresh on each call) ── */
  if (message.action === APP_CONFIG.ACTIONS.RELOAD_SETTINGS) {
    sendResponse({ success: true });
    return false;
  }

  return false;
});

/**
 * Calls Notion API to verify the key + database ID combination and configure properties.
 */
async function testNotionConnection(apiKey, databaseId, selectedSources = []) {
  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      // If it's a 400/404, the user might have provided a Page ID instead of a Database ID
      if (res.status === 404 || res.status === 400 || (data && data.code === 'object_not_found') || (data && data.code === 'validation_error')) {
        const pageRes = await fetch(`https://api.notion.com/v1/pages/${databaseId}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Notion-Version': NOTION_VERSION,
            'Content-Type': 'application/json',
          },
        });
        
        if (pageRes.ok) {
          // The ID is a valid page — auto-create a database inside it
          const optionsPayload = (selectedSources || []).map(src => ({ name: src }));
          
          const createBody = {
            parent: { type: 'page_id', page_id: databaseId },
            title: [
              { type: 'text', text: { content: 'Saved Bookmarks' } }
            ],
            properties: {
              [APP_CONFIG.NOTION_PROPERTIES.TITLE]: { title: {} },
              [APP_CONFIG.NOTION_PROPERTIES.URL]: { url: {} },
              [APP_CONFIG.NOTION_PROPERTIES.SOURCE]: {
                multi_select: {
                  options: optionsPayload.length > 0 ? optionsPayload : []
                }
              }
            }
          };

          const createRes = await fetch(`https://api.notion.com/v1/databases`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Notion-Version': NOTION_VERSION,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(createBody)
          });

          if (createRes.ok) {
            const createData = await createRes.json();
            console.log('[background] Auto-created database inside page:', createData.id);
            return {
              success: true,
              databaseTitle: 'Saved Bookmarks',
              sourceType: 'multi_select',
              newDatabaseId: createData.id
            };
          } else {
            const createErr = await createRes.json().catch(() => ({}));
            console.warn('[background] Failed to auto-create database:', createErr.message);
            return {
              success: false,
              error: 'CONNECTION_FAILED',
              message: `Could not create database inside this page: ${createErr.message || 'Unknown error'}`
            };
          }
        }
      }

      return {
        success: false,
        error: 'CONNECTION_FAILED',
        status: res.status,
        message: data.message || `Notion returned ${res.status}`
      };
    }

    // Verify required properties exist
    const properties = data.properties || {};
    const missing = [];

    // Title is required by default, but we should make sure it exists with 'title' type
    if (!properties[APP_CONFIG.NOTION_PROPERTIES.TITLE] || properties[APP_CONFIG.NOTION_PROPERTIES.TITLE].type !== 'title') {
      missing.push(`${APP_CONFIG.NOTION_PROPERTIES.TITLE} (type: Title)`);
    }
    if (!properties[APP_CONFIG.NOTION_PROPERTIES.URL] || properties[APP_CONFIG.NOTION_PROPERTIES.URL].type !== 'url') {
      missing.push(`${APP_CONFIG.NOTION_PROPERTIES.URL} (type: URL)`);
    }
    
    // Only fail if Source exists but is of an invalid type
    if (properties[APP_CONFIG.NOTION_PROPERTIES.SOURCE] && properties[APP_CONFIG.NOTION_PROPERTIES.SOURCE].type !== 'multi_select' && properties[APP_CONFIG.NOTION_PROPERTIES.SOURCE].type !== 'select') {
      missing.push(`${APP_CONFIG.NOTION_PROPERTIES.SOURCE} (must be Select or Multi-select type, but found ` + properties[APP_CONFIG.NOTION_PROPERTIES.SOURCE].type + ')');
    }

    if (missing.length > 0) {
      return {
        success: false,
        error: 'MISSING_PROPERTIES',
        missingProperties: missing
      };
    }

    // Determine target type (default to multi_select if it does not exist)
    const sourceType = properties[APP_CONFIG.NOTION_PROPERTIES.SOURCE] ? properties[APP_CONFIG.NOTION_PROPERTIES.SOURCE].type : 'multi_select';

    // Auto-create/update Source options in database schema
    if (selectedSources && selectedSources.length > 0) {
      const optionsPayload = selectedSources.map(src => ({ name: src }));
      
      const patchBody = {
        properties: {
          [APP_CONFIG.NOTION_PROPERTIES.SOURCE]: {
            [sourceType]: {
              options: optionsPayload
            }
          }
        }
      };

      const patchRes = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(patchBody)
      });

      if (!patchRes.ok) {
        console.warn('[background] Failed to update/create Source property schema in Notion database');
      } else {
        console.log('[background] Source property schema updated/created successfully in Notion database');
      }
    }

    // Extract database title
    const titleArr = data.title || [];
    const databaseTitle = titleArr.map(t => t.plain_text).join('') || 'Untitled';

    return { success: true, databaseTitle, sourceType };
  } catch (err) {
    return { success: false, error: 'CONNECTION_FAILED', message: `Network error: ${err.message}` };
  }
}

/* ── Context Menu & Notifications ────────────────── */

/**
 * Creates a generic title based on the domain if no text is selected.
 */
function getFallbackTitleFromUrl(url) {
  if (!url) return 'Saved Link';
  try {
    const parsed = new URL(url);
    const source = getSourceFromUrl(url);
    if (source === APP_CONFIG.SOURCE_LABELS.YOUTUBE) return 'Saved YouTube Video';
    if (source === APP_CONFIG.SOURCE_LABELS.X) return 'Saved X Tweet';
    if (source === APP_CONFIG.SOURCE_LABELS.INSTAGRAM) return 'Saved Instagram Post';
    return `Saved Link: ${parsed.hostname}`;
  } catch (e) {
    return 'Saved Link';
  }
}

/**
 * Helper to display basic system notifications.
 */
function showNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png', // Standard existing size
    title: title,
    message: message,
    priority: 2
  });
}

// Register context menu items and handle first-run onboarding page opening
chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.create({
    id: "save-link-to-notion",
    title: "Save Link to Notion",
    contexts: ["link"]
  });
  console.log('[background] Context menu "Save Link to Notion" created successfully.');

  // Open options page on install
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }

  // Programmatic content.js injector into active tabs
  console.log('[background] Injecting content script into active tabs...');
  chrome.tabs.query({ url: [
    "*://*.x.com/*",
    "*://x.com/*",
    "*://*.twitter.com/*",
    "*://twitter.com/*",
    "*://*.instagram.com/*"
  ]}, (tabs) => {
    if (!tabs || tabs.length === 0) return;
    for (const tab of tabs) {
      if (tab.id && tab.url && !tab.url.startsWith('chrome://')) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['constants.js', 'content.js']
        }).then(() => {
          console.log(`[background] Programmatically injected constants.js and content.js into tab ${tab.id} (${tab.url})`);
        }).catch(err => {
          console.warn(`[background] Programmatic injection failed for tab ${tab.id}:`, err.message);
        });
      }
    }
  });
});


// Context Menu click handler
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "save-link-to-notion") return;

  const linkUrl = info.linkUrl;
  if (!linkUrl) return;

  // Use selected link text if available, or generate a source-aware fallback title
  const title = info.selectionText ? `"${info.selectionText}"` : getFallbackTitleFromUrl(linkUrl);

  console.log(`[contextMenu] Detected click. URL: ${linkUrl}, Title: ${title}`);

  // Fetch or trigger background save
  saveToNotion(title, linkUrl).then(async (result) => {
    try {
      const data = await chrome.storage.local.get('showNotifications');
      const showNotif = data.showNotifications !== false; // Default to true
      if (showNotif) {
        if (result.success) {
          showNotification('Saved to Notion! 🎉', `${title}\nSaved successfully.`);
        } else {
          showNotification('Failed to Save ✕', result.error || 'Unknown background error.');
        }
      }
    } catch (e) {
      if (result.success) {
        showNotification('Saved to Notion! 🎉', `${title}\nSaved successfully.`);
      }
    }
  });
});
