import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    permissions: ['contextMenus', 'declarativeNetRequest', 'downloads', 'scripting', 'tabs'],
    host_permissions: [
      'https://*.instagram.com/*',
      'https://www.instagram.com/*',
      '*://www.tiktok.com/*',
    ],
    action: {
      default_title: '__MSG_extDescription__',
    },
  },
});
