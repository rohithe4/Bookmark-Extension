// constants.js

const APP_CONFIG = {
  NOTION_API_VERSION: '2022-06-28',
  OPTIONS_PAGE: 'options.html',
  PAGES: {
    POPUP: 'popup.html',
    OPTIONS: 'options.html'
  },
  SOURCE_LABELS: {
    X: 'X / Twitter',
    INSTAGRAM: 'Instagram',
    YOUTUBE: 'YouTube',
    GENERAL: 'General web pages',
    REDDIT: 'Reddit',
    LINKEDIN: 'LinkedIn'
  },
  NOTION_PROPERTIES: {
    TITLE: 'Title',
    URL: 'URL',
    SOURCE: 'Source'
  },
  URLS: {
    NOTION_CONNECTIONS: 'https://www.notion.so/my-integrations',
    NOTION_CREATE_DATABASE: 'https://www.notion.com/help/create-a-database',
    NOTION_CONNECTIONS_HELP: 'https://www.notion.com/help/add-and-manage-connections-with-the-api'
  },
  ACTIONS: {
    SAVE_TO_NOTION: 'SAVE_TO_NOTION',
    SAVE_X_BOOKMARK: 'SAVE_X_BOOKMARK',
    GET_BOOKMARKS: 'GET_BOOKMARKS',
    DELETE_BOOKMARK: 'DELETE_BOOKMARK',
    TEST_NOTION_CONNECTION: 'TEST_NOTION_CONNECTION',
    RELOAD_SETTINGS: 'RELOAD_SETTINGS'
  }
};

if (typeof self !== 'undefined') {
  self.APP_CONFIG = APP_CONFIG;
} else if (typeof window !== 'undefined') {
  window.APP_CONFIG = APP_CONFIG;
}
