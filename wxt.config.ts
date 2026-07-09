import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Meta Downloader',
    description: 'View & download Instagram and TikTok profile pictures in full size.',
    permissions: ['contextMenus', 'declarativeNetRequest', 'downloads', 'scripting', 'tabs'],
    host_permissions: [
      'https://*.instagram.com/*',
      'https://www.instagram.com/*',
      '*://www.tiktok.com/*',
    ],
    action: {
      default_title: 'View/download Instagram & TikTok profile picture',
    },
    declarative_net_request: {
      rule_resources: [{ id: 'ruleset_1', enabled: true, path: 'rules.json' }],
    },
  },
});
