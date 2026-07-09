// User-Agent strings required by Instagram's private API for each endpoint.
const IG_UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 12_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 105.0.0.11.118 (iPhone11,8; iOS 12_3_1; en_US; en-US; scale=2.00; 828x1792; 165586599)';
const IG_UA_ANDROID =
  'Mozilla/5.0 (Linux; Android 9; GM1903 Build/PKQ1.190110.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/75.0.3770.143 Mobile Safari/537.36 Instagram 103.1.0.15.119 Android (28/9; 420dpi; 1080x2260; OnePlus; GM1903; OnePlus7; qcom; sv_SE; 164094539)';

interface HandleOptions {
  download: boolean;
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({
      title: browser.i18n.getMessage('extName'),
      id: 'parent',
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

  //MARK:Popup
  // The action has a popup, so onClicked never fires — the popup's
  // "Download" button asks for the download via this message instead.
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'download-profile-picture') return;
    (async () => {
      try {
        const tab = await getCurrentTab();
        await handleProfilePicture(tab, { download: true });
        sendResponse({});
      } catch (error) {
        console.warn('error:download-profile-picture:', error);
        sendResponse({ error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return true;
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
      await handleProfilePicture(tab, { download: false });
    } catch (error) {
      console.warn('error:genericOnClick:', error);
    }
  });

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
    const username = parseInstagramUsername(tab.url!);
    const profile = await getInstagramWebProfile(username);
    const imageUrl = await resolveInstagramImageUrl(profile, tab.id);

    if (!imageUrl) {
      console.warn('[IG] could not resolve image url; profile:', JSON.stringify(profile));
      throw new Error('Could not resolve Instagram profile picture URL');
    }

    if (download) {
      browser.downloads.download({
        url: imageUrl,
        filename: `${profile.username || username}.jpg`,
        saveAs: false,
      });
    } else {
      browser.tabs.create({ url: imageUrl });
    }
  }

  function parseInstagramUsername(link: string) {
    const match = link.match(/(?<=instagram\.com\/)[A-Za-z0-9_.]+/);
    if (!match) throw new Error(`Could not parse Instagram username from: ${link}`);
    return match[0];
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
  //   1. IG's own web GraphQL (true 1080px "www" image, needs an active IG login)
  //   2. Private mobile /info/ endpoint (1080px but often center-cropped)
  //   3. URLs already present in the web profile (last resort, ~320px)
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
      browser.downloads.download({
        url: pictureUrl,
        filename: `${username.replace(/[^a-zA-Z0-9_-]/g, '')}.jpg`,
        saveAs: false,
      });
    } else {
      browser.tabs.create({ url: pictureUrl });
    }
  }

  function parseTiktokUsername(link: string) {
    const match = link.match(/(?<=tiktok\.com\/)@[a-zA-Z0-9.]*/);
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
