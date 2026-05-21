# Notion Bookmark Saver

A Chrome extension that saves bookmarks from X (Twitter), Instagram, and other websites directly to your Notion database.

## Features

- Auto-save X/Twitter bookmarks when you click the bookmark button on a post.
- Auto-save Instagram posts.
- Save any webpage from the right-click menu.
- Automatically categorize saved items by source.
- Beginner-friendly setup wizard.
- Duplicate prevention.
- Local-only storage for credentials.

## Installation

### Step 1: Download the extension

```bash
git clone https://github.com/rohithe4/Bookmark-Extension.git
```

Or download the ZIP file and extract it.

### Step 2: Load in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Enable Developer mode
3. Click Load unpacked
4. Select the extension folder
5. The extension will appear in your toolbar

### Step 3: Set up Notion

1. Click the extension icon
2. Click Set up to open the onboarding wizard
3. Complete the 4-step setup:
   - Create a Notion database
   - Create a Notion connection
   - Paste your credentials
   - Test the connection
4. Start saving bookmarks

## Prerequisites

You need:
- A Notion account
- A Notion database with these properties:
  - Title
  - URL
  - Source

The onboarding flow will guide you through this setup.

## How to Use

### Save from X/Twitter
1. Browse X/Twitter
2. Click the bookmark button on any post
3. The post is saved to Notion

### Save from Instagram
1. Browse Instagram
2. Click the bookmark/save button on any post
3. The post is saved to Notion

### Save from anywhere
1. Right-click any webpage
2. Select Save to Notion
3. The page is saved instantly

### Use the popup
1. Click the extension icon on any page
2. Click Save this page
3. The current page is saved to Notion

## Supported Platforms

The extension automatically detects and categorizes saves from:
- X / Twitter
- Instagram
- YouTube
- Any other website, tagged as General

## Configuration

### Change settings
Click the gear icon in the extension popup to:
- Update your Notion credentials
- Re-test your connection
- Change source preferences

### Data storage
- Settings are stored locally in Chrome
- Your Notion API key stays on your device
- No data is sent to third-party services except Notion

## Screenshots

Add screenshots here showing:
- Extension popup
- Onboarding wizard
- Saved items in Notion
- Right-click context menu

## Privacy and Security

- Your Notion API key is stored using `chrome.storage.local`
- No telemetry or analytics
- No external API calls except to Notion
- Open source so you can review the code

## Troubleshooting

### Extension won't save bookmarks
1. Make sure you completed setup
2. Run Test Connection in settings
3. Check that your Notion database has the required properties

### Could not connect to Notion
1. Verify the access token
2. Make sure the database was shared with the connection
3. Check that the database URL is correct

### Bookmarks are duplicated
The extension checks for duplicate URLs before saving. If duplicates appear:
1. Make sure you are using the same database
2. Reload the extension

### Settings button does not work
1. Reload the extension at `chrome://extensions`
2. Make sure the extension is enabled
3. Check the browser console for errors

## Contributing

Contributions are welcome. You can:
- Report bugs
- Suggest features
- Submit pull requests


## Acknowledgments

- Built with Chrome Extension Manifest V3
- Uses the Notion API

## Support

For help:
- Open an issue on GitHub
- Review the onboarding wizard
- Check the Notion API documentation
