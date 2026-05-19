/**
 * options.js — Onboarding & settings logic for Notion Bookmark.
 *
 * Responsibilities:
 * - Multi-step wizard navigation (step 1 → 4 progressive disclosure)
 * - Switch between step-by-step Wizard and dedicated Settings panel
 * - Mask secrets: do not preload raw secret keys into DOM values, use memory-cached variables
 * - Auto-extract Notion Database ID from any URL format
 * - Validate API key and database field formats client-side
 * - Test connection via background service worker (keeps secrets out of content scripts)
 * - Validate properties returned from connection check (Title, URL, Source)
 * - Save secrets securely using chrome.storage.local (never synced)
 * - Connection test is the gatekeeper — saving is only enabled after a successful test
 */

'use strict';

/* ══════════════════════════════════════
   DOM refs
   ══════════════════════════════════════ */
const wizardContainer = document.getElementById('wizardContainer');
const settingsPanel   = document.getElementById('settingsPanel');

// Wizard steps & cards
const step1Card = document.getElementById('step1Card');
const step2Card = document.getElementById('step2Card');
const step3Card = document.getElementById('step3Card');
const step4Card = document.getElementById('step4Card');

const step1Next     = document.getElementById('step1Next');
const step2Back     = document.getElementById('step2Back');
const step2Next     = document.getElementById('step2Next');
const step3Back     = document.getElementById('step3Back');
const testConnBtn   = document.getElementById('testConnBtn');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const step4Finish   = document.getElementById('step4Finish');
const startOverLink = document.getElementById('startOverLink');

const apiKeyInput        = document.getElementById('apiKeyInput');
const apiKeyValidation   = document.getElementById('apiKeyValidation');
const dbInput            = document.getElementById('dbInput');
const dbValidation       = document.getElementById('dbValidation');
const extractedIdBox     = document.getElementById('extractedIdBox');
const extractedIdValue   = document.getElementById('extractedIdValue');
const connResult         = document.getElementById('connResult');
const connResultIcon     = document.getElementById('connResultIcon');
const connResultTitle    = document.getElementById('connResultTitle');
const connResultDetail   = document.getElementById('connResultDetail');
const savedBanner        = document.getElementById('savedBanner');

// Settings panel fields
const settingsApiKeyInput       = document.getElementById('settingsApiKeyInput');
const settingsApiKeyValidation  = document.getElementById('settingsApiKeyValidation');
const settingsDbInput           = document.getElementById('settingsDbInput');
const settingsDbValidation      = document.getElementById('settingsDbValidation');
const settingsExtractedIdBox    = document.getElementById('settingsExtractedIdBox');
const settingsExtractedIdValue  = document.getElementById('settingsExtractedIdValue');
const settingsConnResult        = document.getElementById('settingsConnResult');
const settingsConnResultIcon    = document.getElementById('settingsConnResultIcon');
const settingsConnResultTitle   = document.getElementById('settingsConnResultTitle');
const settingsConnResultDetail  = document.getElementById('settingsConnResultDetail');
const settingsSavedBanner       = document.getElementById('settingsSavedBanner');
const settingsTestConnBtn       = document.getElementById('settingsTestConnBtn');
const settingsSaveBtn           = document.getElementById('settingsSaveBtn');

// Settings checkboxes
const toggleXBookmarks      = document.getElementById('toggleXBookmarks');
const toggleInstagram       = document.getElementById('toggleInstagram');
const toggleNotifications   = document.getElementById('toggleNotifications');
const settingsLaunchWizardLink = document.getElementById('settingsLaunchWizardLink');

const editApiKeyBtn = document.getElementById('editApiKeyBtn');
const settingsEditApiKeyBtn = document.getElementById('settingsEditApiKeyBtn');

// Revoke connection elements
const revokeConnectionBtn = document.getElementById('revokeConnectionBtn');
const revokeConfirmBox    = document.getElementById('revokeConfirmBox');
const cancelRevokeBtn     = document.getElementById('cancelRevokeBtn');
const confirmRevokeBtn    = document.getElementById('confirmRevokeBtn');

// Source configuration checkboxes
const sourcePrefCheckboxes = document.querySelectorAll('.source-pref-checkbox');
const settingsSourceCheckboxes = document.querySelectorAll('.settings-source-checkbox');

/* ══════════════════════════════════════
   IN-MEMORY CACHE (SECURE MASKS)
   ══════════════════════════════════════ */
let savedApiKey = '';
let savedDatabaseId = '';
let savedSourcePropertyType = 'multi_select';
let wizardConnectionVerified = false;
let settingsConnectionVerified = false;

/* ══════════════════════════════════════
   DATABASE ID EXTRACTION
   ══════════════════════════════════════ */

/**
 * Extracts a Notion database ID from any input:
 * - Full URL: https://www.notion.so/workspace/Name-<32hexchars>?v=...
 * - Short URL: https://notion.so/<32hexchars>
 * - UUID with hyphens: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 * - Raw 32-char hex string
 *
 * Returns the normalized ID (no hyphens) or null if not found.
 */
function extractDatabaseId(input) {
  if (!input || typeof input !== 'string') return null;
  const raw = input.trim();

  // 1. UUID format (with hyphens): 8-4-4-4-12
  const uuidMatch = raw.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
  if (uuidMatch) return uuidMatch[1].replace(/-/g, '');

  // 2. 32 raw hex chars (no hyphens) anywhere in the string
  const hexMatch = raw.match(/\b([0-9a-f]{32})\b/i);
  if (hexMatch) return hexMatch[1].toLowerCase();

  // 3. Try parsing as URL and extracting from path/query
  try {
    const url = new URL(raw);
    const pathParts = url.pathname.split('/').filter(Boolean);
    for (const part of pathParts) {
      // Part may be "MyDatabase-<32hex>" or just "<32hex>"
      const trailingHex = part.match(/([0-9a-f]{32})$/i);
      if (trailingHex) return trailingHex[1].toLowerCase();
    }
  } catch (e) {
    // Not a valid URL; already tried plain patterns above
  }

  return null;
}

/**
 * Formats a raw 32-char hex ID into the standard UUID hyphen format.
 */
function formatAsUuid(id) {
  if (!id || id.length !== 32) return id;
  return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}

/* ══════════════════════════════════════
   VALIDATION HELPERS
   ══════════════════════════════════════ */

function isValidApiKey(key) {
  if (!key) return false;
  const k = key.trim();
  return (k.startsWith('ntn_') || k.startsWith('secret_')) && k.length >= 20;
}

function setFieldState(input, validationEl, state, message) {
  input.classList.remove('valid', 'invalid');
  validationEl.className = 'field-validation';
  validationEl.textContent = '';

  if (state === 'success') {
    input.classList.add('valid');
    validationEl.classList.add('success');
    validationEl.textContent = message || '';
  } else if (state === 'error') {
    input.classList.add('invalid');
    validationEl.classList.add('error');
    validationEl.textContent = message || '';
  }
}

/* ══════════════════════════════════════
   ROUTING & WIZARD NAVIGATION
   ══════════════════════════════════════ */

function showView(view) {
  if (view === 'settings') {
    wizardContainer.style.display = 'none';
    settingsPanel.style.display = 'block';
  } else {
    wizardContainer.style.display = 'flex';
    settingsPanel.style.display = 'none';
  }
}

let currentStep = 1;

function goToStep(n) {
  currentStep = n;

  [step1Card, step2Card, step3Card, step4Card].forEach((c, i) => {
    c.classList.toggle('active', i + 1 === n);
  });

  // Progress Bar Indicators: Completed = '✓', Active = '●', Upcoming = '○'
  for (let i = 1; i <= 4; i++) {
    const ps = document.getElementById(`ps${i}`);
    if (!ps) continue;

    ps.classList.remove('active', 'completed');
    const statusEl = ps.querySelector('.step-status');

    if (i < n) {
      ps.classList.add('completed');
      if (statusEl) statusEl.textContent = '✓';
    } else if (i === n) {
      ps.classList.add('active');
      if (statusEl) statusEl.textContent = '●';
    } else {
      if (statusEl) statusEl.textContent = '○';
    }
  }
}

// Navigation flow binding
step1Next.addEventListener('click', () => goToStep(2));
step2Back.addEventListener('click', () => goToStep(1));
step2Next.addEventListener('click', () => goToStep(3));
step3Back.addEventListener('click', () => goToStep(2));
step4Finish.addEventListener('click', () => window.close());

// Start over link (onboarding footer)
startOverLink.addEventListener('click', () => {
  wizardConnectionVerified = false;
  saveSettingsBtn.disabled = true;
  hideConnResult(connResult);
  apiKeyInput.value = '';
  dbInput.value = '';
  extractedIdBox.classList.remove('visible');
  goToStep(1);
});

// Launch Setup Wizard link (settings footer)
settingsLaunchWizardLink.addEventListener('click', () => {
  showView('wizard');
  goToStep(1);
});

// Eye toggle button event listeners for type password/text switching
document.querySelectorAll('.eye-toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const targetId = btn.getAttribute('data-target');
    const input = document.getElementById(targetId);
    if (!input) return;

    if (input.type === 'password') {
      input.type = 'text';
      btn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.815 7.815 3 3m-3-3-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
        </svg>
      `;
      // Populate value if empty to display the secret securely
      if (input.value === '') {
        if (targetId === 'apiKeyInput' || targetId === 'settingsApiKeyInput') {
          if (savedApiKey) {
            input.value = savedApiKey;
            // Hide the edit button since key is visible and active
            if (targetId === 'apiKeyInput' && editApiKeyBtn) editApiKeyBtn.style.display = 'none';
            if (targetId === 'settingsApiKeyInput' && settingsEditApiKeyBtn) settingsEditApiKeyBtn.style.display = 'none';
          }
        } else if (targetId === 'dbInput' || targetId === 'settingsDbInput') {
          if (savedDatabaseId) {
            const currentVal = (targetId === 'dbInput' ? dbInput.value : settingsDbInput.value);
            if (!currentVal) {
              chrome.storage.local.get('notionDatabaseRaw', (res) => {
                input.value = res.notionDatabaseRaw || formatAsUuid(savedDatabaseId);
              });
            }
          }
        }
      }
    } else {
      input.type = 'password';
      btn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
        </svg>
      `;
      // Clear value and show mask if it matches saved token
      if (targetId === 'apiKeyInput' || targetId === 'settingsApiKeyInput') {
        if (input.value === savedApiKey) {
          input.value = '';
          input.placeholder = '•••••••••••••••••••• (Saved)';
          // Show edit button again
          if (targetId === 'apiKeyInput' && editApiKeyBtn && savedApiKey) editApiKeyBtn.style.display = 'inline';
          if (targetId === 'settingsApiKeyInput' && settingsEditApiKeyBtn && savedApiKey) settingsEditApiKeyBtn.style.display = 'inline';
        }
      }
    }
  });
});

// Edit API Key Button action
function startEditingApiKey(inputEl, editBtnEl, eyeBtnEl) {
  if (savedApiKey) {
    inputEl.value = savedApiKey;
    inputEl.placeholder = 'Paste your secret token (starts with ntn_ or secret_)';
    inputEl.type = 'text';
    
    // Set eye icon to eye-off/closed SVG
    if (eyeBtnEl) {
      eyeBtnEl.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.815 7.815 3 3m-3-3-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
        </svg>
      `;
    }
  }
  editBtnEl.style.display = 'none';
  inputEl.focus();
}

if (editApiKeyBtn) {
  editApiKeyBtn.addEventListener('click', () => {
    const eyeBtn = document.querySelector('.eye-toggle-btn[data-target="apiKeyInput"]');
    startEditingApiKey(apiKeyInput, editApiKeyBtn, eyeBtn);
  });
}

if (settingsEditApiKeyBtn) {
  settingsEditApiKeyBtn.addEventListener('click', () => {
    const eyeBtn = document.querySelector('.eye-toggle-btn[data-target="settingsApiKeyInput"]');
    startEditingApiKey(settingsApiKeyInput, settingsEditApiKeyBtn, eyeBtn);
  });
}

// Revoke Connection Event Listeners
if (revokeConnectionBtn) {
  revokeConnectionBtn.addEventListener('click', () => {
    if (revokeConfirmBox) {
      revokeConfirmBox.classList.add('active');
    }
  });
}

if (cancelRevokeBtn) {
  cancelRevokeBtn.addEventListener('click', () => {
    if (revokeConfirmBox) {
      revokeConfirmBox.classList.remove('active');
    }
  });
}

if (confirmRevokeBtn) {
  confirmRevokeBtn.addEventListener('click', async () => {
    // Clear all storage securely
    await chrome.storage.local.clear();

    // Reset memory state
    savedApiKey = '';
    savedDatabaseId = '';
    wizardConnectionVerified = false;
    settingsConnectionVerified = false;

    // Reset wizard forms
    apiKeyInput.value = '';
    apiKeyInput.placeholder = 'Paste your secret token (starts with ntn_ or secret_)';
    apiKeyInput.type = 'password';
    dbInput.value = '';
    dbInput.type = 'password';
    dbInput.placeholder = 'Paste your database URL';

    // Reset settings forms
    settingsApiKeyInput.value = '';
    settingsApiKeyInput.placeholder = '•••••••••••••••••••• (Saved)';
    settingsApiKeyInput.type = 'password';
    settingsDbInput.value = '';
    settingsDbInput.type = 'password';
    settingsDbInput.placeholder = 'Paste your database URL or ID';

    // Hide badges & validations
    if (extractedIdBox) extractedIdBox.classList.remove('visible');
    if (settingsExtractedIdBox) settingsExtractedIdBox.classList.remove('visible');
    if (editApiKeyBtn) editApiKeyBtn.style.display = 'none';
    if (settingsEditApiKeyBtn) settingsEditApiKeyBtn.style.display = 'none';
    
    hideConnResult(connResult);
    hideConnResult(settingsConnResult);
    setFieldState(apiKeyInput, apiKeyValidation, 'idle');
    setFieldState(dbInput, dbValidation, 'idle');
    setFieldState(settingsApiKeyInput, settingsApiKeyValidation, 'idle');
    setFieldState(settingsDbInput, settingsDbValidation, 'idle');

    if (revokeConfirmBox) {
      revokeConfirmBox.classList.remove('active');
    }

    // Notify background thread to clear state
    chrome.runtime.sendMessage({ action: 'RELOAD_SETTINGS' }).catch(() => {});

    // Route back to onboarding wizard
    showView('wizard');
    goToStep(1);
  });
}

/* ══════════════════════════════════════
   LIVE INPUT VALIDATION & GATING
   ══════════════════════════════════════ */

// Wizard Inputs
apiKeyInput.addEventListener('input', () => {
  wizardConnectionVerified = false;
  saveSettingsBtn.disabled = true;
  hideConnResult(connResult);

  const val = apiKeyInput.value.trim();
  if (!val) {
    setFieldState(apiKeyInput, apiKeyValidation, 'idle');
    return;
  }
  if (isValidApiKey(val)) {
    setFieldState(apiKeyInput, apiKeyValidation, 'success', '✓ Valid format');
  } else {
    setFieldState(apiKeyInput, apiKeyValidation, 'error', 'Token should start with ntn_ or secret_');
  }
});

dbInput.addEventListener('input', () => {
  wizardConnectionVerified = false;
  saveSettingsBtn.disabled = true;
  hideConnResult(connResult);
  extractedIdBox.classList.remove('visible');

  const val = dbInput.value.trim();
  if (!val) {
    setFieldState(dbInput, dbValidation, 'idle');
    return;
  }
  const id = extractDatabaseId(val);
  if (id) {
    setFieldState(dbInput, dbValidation, 'success', '✓ ID parsed');
    extractedIdValue.textContent = formatAsUuid(id);
    extractedIdBox.classList.add('visible');
  } else {
    setFieldState(dbInput, dbValidation, 'error', 'Invalid database ID or URL format');
  }
});

// Settings Panel Inputs
settingsApiKeyInput.addEventListener('input', () => {
  settingsConnectionVerified = false;
  settingsSaveBtn.disabled = true;
  hideConnResult(settingsConnResult);

  const val = settingsApiKeyInput.value.trim();
  if (!val) {
    setFieldState(settingsApiKeyInput, settingsApiKeyValidation, 'idle');
    return;
  }
  if (isValidApiKey(val)) {
    setFieldState(settingsApiKeyInput, settingsApiKeyValidation, 'success', '✓ Valid format');
  } else {
    setFieldState(settingsApiKeyInput, settingsApiKeyValidation, 'error', 'Token should start with ntn_ or secret_');
  }
});

settingsDbInput.addEventListener('input', () => {
  settingsConnectionVerified = false;
  settingsSaveBtn.disabled = true;
  hideConnResult(settingsConnResult);
  settingsExtractedIdBox.classList.remove('visible');

  const val = settingsDbInput.value.trim();
  if (!val) {
    setFieldState(settingsDbInput, settingsDbValidation, 'idle');
    return;
  }
  const id = extractDatabaseId(val);
  if (id) {
    setFieldState(settingsDbInput, settingsDbValidation, 'success', '✓ ID parsed');
    settingsExtractedIdValue.textContent = formatAsUuid(id);
    settingsExtractedIdBox.classList.add('visible');
  } else {
    setFieldState(settingsDbInput, settingsDbValidation, 'error', 'Invalid database ID or URL format');
  }
});

// Checkbox changes enable the save button
[toggleXBookmarks, toggleInstagram, toggleNotifications].forEach(el => {
  if (el) {
    el.addEventListener('change', () => {
      settingsSaveBtn.disabled = false;
    });
  }
});

// Settings source checkboxes enable the save button on change
settingsSourceCheckboxes.forEach(cb => {
  cb.addEventListener('change', () => {
    settingsSaveBtn.disabled = false;
  });
});

/* ══════════════════════════════════════
   CONNECTION RESULTS RENDERING
   ══════════════════════════════════════ */

function showConnResult(resultEl, resultIconEl, resultTitleEl, resultDetailEl, type, title, detail) {
  resultEl.className = `conn-result visible ${type}`;
  resultIconEl.textContent = type === 'success' ? '✅' : '❌';
  resultTitleEl.textContent = title;
  resultDetailEl.textContent = detail || '';
}

function hideConnResult(resultEl) {
  resultEl.className = 'conn-result';
  const title = resultEl.querySelector('.result-title');
  const detail = resultEl.querySelector('.result-detail');
  if (title) title.textContent = '';
  if (detail) detail.textContent = '';
  
  savedBanner.classList.remove('visible');
  settingsSavedBanner.classList.remove('visible');
}

/* ══════════════════════════════════════
   SECURE CONNECTION TESTING SERVICE
   ══════════════════════════════════════ */

async function performConnectionTest(rawKey, rawDbInput, viewName) {
  const isSettings = viewName === 'settings';
  const targetResult = isSettings ? settingsConnResult : connResult;
  const targetIcon = isSettings ? settingsConnResultIcon : connResultIcon;
  const targetTitle = isSettings ? settingsConnResultTitle : connResultTitle;
  const targetDetail = isSettings ? settingsConnResultDetail : connResultDetail;
  const targetBtn = isSettings ? settingsTestConnBtn : testConnBtn;
  const targetValidation = isSettings ? settingsDbValidation : dbValidation;
  const targetInput = isSettings ? settingsDbInput : dbInput;

  hideConnResult(targetResult);

  // Fallback to memory saved secrets if input is blank (masked placeholder pattern)
  let apiKey = rawKey.trim();
  if (!apiKey && savedApiKey) {
    apiKey = savedApiKey;
  }

  let dbRaw = rawDbInput.trim();
  if (!dbRaw && savedDatabaseId) {
    dbRaw = savedDatabaseId;
  }

  // 1. Token validations
  if (!apiKey) {
    showConnResult(targetResult, targetIcon, targetTitle, targetDetail, 'error', '❌ Please enter an access token.', '');
    return false;
  }

  if (!isValidApiKey(apiKey)) {
    showConnResult(targetResult, targetIcon, targetTitle, targetDetail, 'error', '❌ Token format is invalid.', 'Secret token must begin with secret_ or ntn_');
    return false;
  }

  // 2. Database ID validations
  if (!dbRaw) {
    showConnResult(targetResult, targetIcon, targetTitle, targetDetail, 'error', '❌ Please enter a database link or ID.', '');
    return false;
  }

  const dbId = extractDatabaseId(dbRaw);
  if (!dbId) {
    showConnResult(targetResult, targetIcon, targetTitle, targetDetail, 'error', '❌ Invalid database URL or ID.', '');
    setFieldState(targetInput, targetValidation, 'error', 'Invalid format');
    return false;
  }

  // Loading indicator
  targetBtn.disabled = true;
  const originalText = targetBtn.textContent;
  targetBtn.innerHTML = '<span class="spinner light"></span> Testing…';

  const checkboxes = isSettings ? settingsSourceCheckboxes : sourcePrefCheckboxes;
  const selectedSources = Array.from(checkboxes).filter(cb => cb.checked).map(cb => cb.value);

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'TEST_NOTION_CONNECTION',
      apiKey,
      databaseId: dbId,
      selectedSources
    });

    if (response?.success) {
      if (response.sourceType) {
        savedSourcePropertyType = response.sourceType;
      }
      showConnResult(
        targetResult,
        targetIcon,
        targetTitle,
        targetDetail,
        'success',
        `✅ Connected successfully!\nDatabase Title: "${response.databaseTitle || 'Saved Bookmarks'}"`,
        `Required fields verified:\n• Title (type title) ✓\n• URL (type url) ✓\n• Source (type select or multi_select) ✓`
      );
      return { success: true, verifiedApiKey: apiKey, verifiedDbId: dbId, sourceType: response.sourceType };
    } else {
      if (response?.error === 'MISSING_PROPERTIES') {
        const missing = response.missingProperties.map(p => `  • ${p}`).join('\n');
        showConnResult(
          targetResult,
          targetIcon,
          targetTitle,
          targetDetail,
          'error',
          '❌ Missing required database columns:',
          `${missing}\n\nPlease add these properties in Notion, then test again.`
        );
      } else {
        showConnResult(
          targetResult,
          targetIcon,
          targetTitle,
          targetDetail,
          'error',
          '❌ Connection test failed.',
          'Verify your Notion secret token is correct and database is connected in step 2.'
        );
      }
      return false;
    }
  } catch (err) {
    showConnResult(targetResult, targetIcon, targetTitle, targetDetail, 'error', '❌ Background communication failure.', err.message);
    return false;
  } finally {
    targetBtn.disabled = false;
    targetBtn.textContent = originalText;
  }
}

// Bind connection test buttons
testConnBtn.addEventListener('click', async () => {
  const result = await performConnectionTest(apiKeyInput.value, dbInput.value, 'wizard');
  if (result) {
    wizardConnectionVerified = true;
    saveSettingsBtn.disabled = false;
  } else {
    wizardConnectionVerified = false;
    saveSettingsBtn.disabled = true;
  }
});

settingsTestConnBtn.addEventListener('click', async () => {
  const result = await performConnectionTest(settingsApiKeyInput.value, settingsDbInput.value, 'settings');
  if (result) {
    settingsConnectionVerified = true;
    settingsSaveBtn.disabled = false;
  } else {
    settingsConnectionVerified = false;
    settingsSaveBtn.disabled = true;
  }
});

/* ══════════════════════════════════════
   SAVE SETTINGS SERVICE
   ══════════════════════════════════════ */

async function saveConfiguration(viewName) {
  const isSettings = viewName === 'settings';
  const targetBtn = isSettings ? settingsSaveBtn : saveSettingsBtn;
  const targetResult = isSettings ? settingsConnResult : connResult;
  const targetBanner = isSettings ? settingsSavedBanner : savedBanner;

  const keyInput = isSettings ? settingsApiKeyInput : apiKeyInput;
  const dbValInput = isSettings ? settingsDbInput : dbInput;

  let apiKey = keyInput.value.trim();
  if (!apiKey && savedApiKey) {
    apiKey = savedApiKey;
  }

  let dbRaw = dbValInput.value.trim();
  if (!dbRaw && savedDatabaseId) {
    dbRaw = savedDatabaseId;
  }

  const dbId = extractDatabaseId(dbRaw);

  if (!apiKey || !dbId) return;

  targetBtn.disabled = true;
  const originalText = targetBtn.textContent;
  targetBtn.innerHTML = '<span class="spinner"></span> Saving…';

  const checkboxes = isSettings ? settingsSourceCheckboxes : sourcePrefCheckboxes;
  const enabledSources = Array.from(checkboxes).filter(cb => cb.checked).map(cb => cb.value);

  try {
    // Write options and secure properties to local storage (never synced)
    await chrome.storage.local.set({
      notionApiKey: apiKey,
      notionDatabaseId: dbId,
      notionDatabaseRaw: dbRaw,
      enableXBookmarks: toggleXBookmarks.checked,
      enableInstagram: toggleInstagram.checked,
      showNotifications: toggleNotifications.checked,
      sourcePropertyType: savedSourcePropertyType,
      enabledSources: enabledSources,
      setupComplete: true
    });

    // Sync other checkboxes list in DOM
    const otherCheckboxes = isSettings ? sourcePrefCheckboxes : settingsSourceCheckboxes;
    otherCheckboxes.forEach(ocb => {
      const match = Array.from(checkboxes).find(c => c.value === ocb.value);
      if (match) ocb.checked = match.checked;
    });

    // Notify background worker
    chrome.runtime.sendMessage({ action: 'RELOAD_SETTINGS' }).catch(() => {});

    // Save in-memory cache reference
    savedApiKey = apiKey;
    savedDatabaseId = dbId;

    // Reset masks in DOM
    keyInput.value = '';
    keyInput.placeholder = '•••••••••••••••••••• (Saved)';
    keyInput.type = 'password';
    dbValInput.value = dbRaw;
    dbValInput.type = 'password';

    // Sync eye icon SVGs
    document.querySelectorAll(`.eye-toggle-btn[data-target="${isSettings ? 'settingsApiKeyInput' : 'apiKeyInput'}"], .eye-toggle-btn[data-target="${isSettings ? 'settingsDbInput' : 'dbInput'}"]`).forEach(btn => {
      btn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
        </svg>
      `;
    });

    if (editApiKeyBtn) editApiKeyBtn.style.display = 'inline';
    if (settingsEditApiKeyBtn) settingsEditApiKeyBtn.style.display = 'inline';

    targetBanner.classList.add('visible');

    if (!isSettings) {
      setTimeout(() => {
        goToStep(4);
      }, 1000);
    } else {
      setTimeout(() => {
        targetBanner.classList.remove('visible');
      }, 3000);
    }
  } catch (err) {
    showConnResult(
      isSettings ? settingsConnResult : connResult,
      isSettings ? settingsConnResultIcon : connResultIcon,
      isSettings ? settingsConnResultTitle : connResultTitle,
      isSettings ? settingsConnResultDetail : connResultDetail,
      'error',
      'Failed to save configuration settings.',
      err.message
    );
  } finally {
    targetBtn.disabled = false;
    targetBtn.textContent = originalText;
  }
}

saveSettingsBtn.addEventListener('click', () => saveConfiguration('wizard'));
settingsSaveBtn.addEventListener('click', () => saveConfiguration('settings'));

/* ══════════════════════════════════════
   LOAD EXISTING CONFIGURATION ON STARTUP
   ══════════════════════════════════════ */

async function loadExistingSettings() {
  try {
    const data = await chrome.storage.local.get([
      'notionApiKey',
      'notionDatabaseId',
      'notionDatabaseRaw',
      'enableXBookmarks',
      'enableInstagram',
      'showNotifications',
      'sourcePropertyType',
      'enabledSources',
      'setupComplete'
    ]);

    // Retrieve API key to memory only (masking inputs)
    if (data.notionApiKey) {
      savedApiKey = data.notionApiKey;
      apiKeyInput.placeholder = '•••••••••••••••••••• (Saved)';
      settingsApiKeyInput.placeholder = '•••••••••••••••••••• (Saved)';
      if (editApiKeyBtn) editApiKeyBtn.style.display = 'inline';
      if (settingsEditApiKeyBtn) settingsEditApiKeyBtn.style.display = 'inline';
    }

    // Retrieve database details
    if (data.notionDatabaseRaw || data.notionDatabaseId) {
      savedDatabaseId = data.notionDatabaseId;
      const displayVal = data.notionDatabaseRaw || formatAsUuid(data.notionDatabaseId);
      
      dbInput.value = displayVal;
      settingsDbInput.value = displayVal;

      extractedIdValue.textContent = formatAsUuid(data.notionDatabaseId);
      extractedIdBox.classList.add('visible');

      settingsExtractedIdValue.textContent = formatAsUuid(data.notionDatabaseId);
      settingsExtractedIdBox.classList.add('visible');
    }

    // Checkbox preferences (defaulting to true)
    toggleXBookmarks.checked = data.enableXBookmarks !== false;
    toggleInstagram.checked = data.enableInstagram !== false;
    toggleNotifications.checked = data.showNotifications !== false;

    if (data.sourcePropertyType) {
      savedSourcePropertyType = data.sourcePropertyType;
    }

    // Source preferences
    const sourcesList = data.enabledSources || ['X / Twitter', 'Instagram', 'YouTube', 'Reddit', 'LinkedIn', 'General web pages'];
    sourcePrefCheckboxes.forEach(cb => {
      cb.checked = sourcesList.includes(cb.value);
    });
    settingsSourceCheckboxes.forEach(cb => {
      cb.checked = sourcesList.includes(cb.value);
    });

    // View routing selection
    if (data.setupComplete) {
      showView('settings');
    } else {
      showView('wizard');
      goToStep(1);
    }
  } catch (err) {
    // Fail closed
    showView('wizard');
    goToStep(1);
  }
}

/* ══════════════════════════════════════
   BOOT
   ══════════════════════════════════════ */
loadExistingSettings();
