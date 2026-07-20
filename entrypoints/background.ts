import { parseIgUsername } from '@/utils/ig';
import { loadFlags } from '@/utils/flags';

// User-Agent strings required by Instagram's private API for each endpoint.
const IG_UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 12_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 105.0.0.11.118 (iPhone11,8; iOS 12_3_1; en_US; en-US; scale=2.00; 828x1792; 165586599)';
const IG_UA_ANDROID =
  'Mozilla/5.0 (Linux; Android 9; GM1903 Build/PKQ1.190110.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/75.0.3770.143 Mobile Safari/537.36 Instagram 103.1.0.15.119 Android (28/9; 420dpi; 1080x2260; OnePlus; GM1903; OnePlus7; qcom; sv_SE; 164094539)';

interface HandleOptions {
  download: boolean;
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(async () => {
    // onInstalled also fires on extension update, where the menu still
    // exists — creating it again without removeAll throws "duplicate id".
    await browser.contextMenus.removeAll();
    browser.contextMenus.create({
      title: browser.i18n.getMessage('extName'),
      id: 'parent',
      documentUrlPatterns: ['*://*.instagram.com/*', '*://*.tiktok.com/*'],
    });
  });

  async function getCurrentTab() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab found.');
    return tab;
  }

  // Routes a tab to the matching platform handler.
  async function handleProfilePicture(tab: Browser.tabs.Tab, { download }: HandleOptions) {
    if (!tab.url) return;
    if (tab.url.includes('instagram.com')) {
      await handleInstagram(tab, { download });
    } else if (tab.url.includes('tiktok.com')) {
      await handleTiktok(tab.url, { download });
    }
  }

  const errMsg = (error: unknown) => (error instanceof Error ? error.message : String(error));

  // Chunked base64 encode — spreading the whole array into fromCharCode blows
  // the call-stack on large media, so walk it in 32 KB slices.
  function bytesToBase64(bytes: Uint8Array): string {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  //MARK:Messages
  // Two reasons the content scripts route requests through here:
  //   • The action has a popup, so action.onClicked never fires — the popup's
  //     "Download" button asks for the profile-picture download instead.
  //   • In MV3, cross-origin fetches from a content script do NOT inherit the
  //     extension's host_permissions (no CORS bypass), but the background
  //     service worker does. So all IG-CDN media fetches happen here.
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const type = message?.type;

    if (type === 'download-profile-picture') {
      (async () => {
        try {
          const tab = await getCurrentTab();
          await handleProfilePicture(tab, { download: true });
          sendResponse({});
        } catch (error) {
          console.warn('error:download-profile-picture:', error);
          sendResponse({ error: errMsg(error) });
        }
      })();
      return true;
    }

    // Save a media URL to the Downloads folder (post / story).
    if (type === 'download-media') {
      (async () => {
        try {
          await browser.downloads.download({ url: message.url, filename: message.filename, saveAs: false });
          sendResponse({});
        } catch (error) {
          sendResponse({ error: errMsg(error) });
        }
      })();
      return true;
    }

    // Fetch media bytes (base64) for the content script to write into a
    // user-picked folder (whole-account download).
    if (type === 'fetch-media') {
      (async () => {
        try {
          const res = await fetch(message.url);
          if (!res.ok) throw new Error(`fetch failed (${res.status})`);
          const buf = await res.arrayBuffer();
          sendResponse({ base64: bytesToBase64(new Uint8Array(buf)) });
        } catch (error) {
          sendResponse({ error: errMsg(error) });
        }
      })();
      return true;
    }
  });

  //MARK:Context menu
  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== 'parent') {
      console.warn('error:contextMenus-onClicked');
      return;
    }
    try {
      if (!tab?.url) {
        console.warn('Tab or URL is undefined');
        return;
      }
      if (!(await loadFlags()).profilePic) return; // feature disabled in popup
      await handleProfilePicture(tab, { download: false });
    } catch (error) {
      console.warn('error:genericOnClick:', error);
      flashErrorBadge();
    }
  });

  // Context-menu failures have no UI of their own — flash a badge on the
  // toolbar icon so the user at least sees something went wrong.
  function flashErrorBadge() {
    // MV2 Firefox exposes browserAction instead of action.
    const action = browser.action ?? (browser as any).browserAction;
    action.setBadgeText({ text: '!' }).catch(() => {});
    action.setBadgeBackgroundColor({ color: '#e5484d' }).catch(() => {});
    setTimeout(() => action.setBadgeText({ text: '' }).catch(() => {}), 3000);
  }

  // Applies a dynamic User-Agent override. Returns a promise so callers can
  // await it and guarantee the rule is active before the request fires.
  function modifyHeaders(headerStr: string) {
    return browser.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1],
      addRules: [
        {
          id: 1,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'User-Agent', operation: 'set', value: headerStr }],
          },
          condition: {
            urlFilter: 'https://i.instagram.com/api/v1/users/*',
            resourceTypes: ['main_frame', 'script', 'sub_frame', 'xmlhttprequest'],
          },
        },
      ],
    });
  }

  //MARK:Instagram
  async function handleInstagram(tab: Browser.tabs.Tab, { download }: HandleOptions) {
    const username = parseIgUsername(tab.url!);
    const profile = await getInstagramWebProfile(username);
    const imageUrl = await resolveInstagramImageUrl(profile, tab.id);

    if (!imageUrl) {
      console.warn('[IG] could not resolve image url; profile:', JSON.stringify(profile));
      throw new Error('Could not resolve Instagram profile picture URL');
    }

    if (download) {
      await browser.downloads.download({
        url: imageUrl,
        filename: `${profile.username || username}.jpg`,
        saveAs: false,
      });
    } else {
      await browser.tabs.create({ url: imageUrl });
    }
  }

  // Fetches the public web profile. This endpoint is reliable (it rides the
  // browser's logged-in instagram.com cookies) and already carries the profile
  // picture URLs as a guaranteed fallback.
  async function getInstagramWebProfile(username: string) {
    await modifyHeaders(IG_UA_IPHONE);
    const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`IG web_profile_info failed: ${res.status}`);
    const out = await res.json();
    const user = out?.data?.user;
    if (!user?.id) throw new Error('IG web_profile_info missing user id');
    return user;
  }

  // Tries the highest-res source first and falls back down the chain:
  //   1. IG's own web GraphQL (full-resolution HD "www" image, needs an active IG login)
  //   2. Private mobile /info/ endpoint (HD but often center-cropped)
  //   3. URLs already present in the web profile (last resort, low-resolution)
  async function resolveInstagramImageUrl(profile: any, tabId: number | undefined) {
    try {
      const hd = await getInstagramHDViaGraphQL(profile, tabId);
      if (hd) return hd;
    } catch (error) {
      console.warn('[IG] GraphQL HD lookup failed, falling back:', error);
    }
    try {
      const info = await getInstagramUserInfo(profile.id);
      const hd = info?.hd_profile_pic_url_info?.url;
      if (hd) return hd;
    } catch (error) {
      console.warn('[IG] /info/ lookup failed, falling back to web profile:', error);
    }
    return profile.profile_pic_url_hd || profile.profile_pic_url;
  }

  async function getInstagramUserInfo(userId: string) {
    await modifyHeaders(IG_UA_ANDROID);
    const url = `https://i.instagram.com/api/v1/users/${userId}/info/`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`IG user info failed: ${res.status}`);
    const out = await res.json();
    return out.user;
  }

  // doc_id for IG's internal "PolarisProfilePageContentQuery" persisted GraphQL
  // query. Meta rotates this whenever the web JS bundle redeploys, with no
  // warning, so this is expected to break periodically — that's fine, the
  // caller just falls back to the lower-res mobile API.
  const IG_PROFILE_DOC_ID = '26672929172408668';

  // Requires an active Instagram login. The whole request runs INSIDE the IG tab
  // (via scripting.executeScript), so it inherits the page's own origin, referer,
  // cookies and session tokens — a service-worker fetch gets rejected by IG's
  // session-integrity check (error 1357004). Version params (__rev/__spin_*/__hs)
  // are scraped from the page to satisfy that same check; missing ones are omitted.
  async function getInstagramHDViaGraphQL(profile: any, tabId: number | undefined) {
    if (!tabId) throw new Error('No tab id for IG GraphQL request');
    const [{ result } = {} as any] = await browser.scripting.executeScript({
      target: { tabId },
      args: [{ docId: IG_PROFILE_DOC_ID, userId: String(profile.id) }],
      func: async ({ docId, userId }: { docId: string; userId: string }) => {
        // Tokens/version params live only in inline <script> JSON. Scanning those
        // is far cheaper than serialising the whole rendered DOM via innerHTML.
        let html = '';
        for (const s of document.scripts) html += s.textContent;
        const pick = (re: RegExp) => html.match(re)?.[1];

        const fbDtsg = pick(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/);
        const lsd = pick(/"LSD",\[\],\{"token":"([^"]+)"/);
        const csrftoken = document.cookie.match(/csrftoken=([^;]+)/)?.[1];
        if (!fbDtsg || !lsd || !csrftoken) {
          return {
            error: 'missing tokens',
            hasDtsg: !!fbDtsg,
            hasLsd: !!lsd,
            hasCsrf: !!csrftoken,
          };
        }

        let jz = 0;
        for (const ch of fbDtsg) jz += ch.charCodeAt(0);

        const body = new URLSearchParams({
          av: '17841406999930309',
          __a: '1',
          __comet_req: '7',
          fb_dtsg: fbDtsg,
          jazoest: `2${jz}`,
          lsd,
          fb_api_caller_class: 'RelayModern',
          fb_api_req_friendly_name: 'PolarisProfilePageContentQuery',
          variables: JSON.stringify({
            enable_integrity_filters: true,
            id: userId,
            __relay_internal__pv__PolarisCannesGuardianExperienceEnabledrelayprovider: true,
            __relay_internal__pv__PolarisCASB976ProfileEnabledrelayprovider: false,
            __relay_internal__pv__PolarisWebSchoolsEnabledrelayprovider: false,
            __relay_internal__pv__PolarisRepostsConsumptionEnabledrelayprovider: false,
          }),
          server_timestamps: 'true',
          doc_id: docId,
        });

        const version: [string, RegExp][] = [
          ['__rev', /"(?:__spin_r|spin_r|server_revision|client_revision)":(\d+)/],
          ['__spin_r', /"(?:__spin_r|spin_r|server_revision|client_revision)":(\d+)/],
          ['__spin_b', /"(?:__spin_b|spin_b)":"([^"]+)"/],
          ['__spin_t', /"(?:__spin_t|spin_t)":(\d+)/],
          ['__hs', /"(?:__hs|haste_session)":"([^"]+)"/],
          ['__hsi', /"(?:__hsi|hsi)":"?(\d+)"?/],
        ];
        for (const [key, re] of version) {
          const v = html.match(re)?.[1];
          if (v) body.set(key, v);
        }

        const res = await fetch('/api/graphql', {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'x-fb-friendly-name': 'PolarisProfilePageContentQuery',
            'x-fb-lsd': lsd,
            'x-csrftoken': csrftoken,
            'x-ig-app-id': '936619743392459',
            'x-asbd-id': '359341',
          },
          body: body.toString(),
        });
        const text = await res.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          return { error: 'bad json', status: res.status, snippet: text.slice(0, 200) };
        }
        const url = json?.data?.user?.hd_profile_pic_url_info?.url;
        if (url) return { url };
        return { error: 'no url', igError: json?.error, igSummary: json?.errorSummary };
      },
    });

    if (result?.url) return result.url;
    throw new Error(`IG GraphQL: ${JSON.stringify(result)}`);
  }

  //MARK:Tiktok
  async function handleTiktok(url: string, { download }: HandleOptions) {
    const username = parseTiktokUsername(url);
    const pictureUrl = await getTiktokProfilePictureUrl(username);

    if (download) {
      await browser.downloads.download({
        url: pictureUrl,
        filename: `${username.replace(/[^a-zA-Z0-9_-]/g, '')}.jpg`,
        saveAs: false,
      });
    } else {
      await browser.tabs.create({ url: pictureUrl });
    }
  }

  function parseTiktokUsername(link: string) {
    const match = link.match(/(?<=tiktok\.com\/)@[\w.]+/);
    if (!match) throw new Error(`Could not parse TikTok username from: ${link}`);
    return match[0];
  }

  async function getTiktokProfilePictureUrl(username: string) {
    const res = await fetch(`https://www.tiktok.com/${username}`);
    if (!res.ok) throw new Error(`TikTok page fetch failed: ${res.status}`);
    const html = await res.text();

    const match = html.match(/(?<=avatarLarger":").+?(?=","avatarMedium)/);
    if (!match) throw new Error('Could not find TikTok avatar in page HTML');

    return decodeURIComponent(JSON.parse(`"${match[0]}"`));
  }
});
