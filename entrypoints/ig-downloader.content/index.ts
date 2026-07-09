import './style.css';
import { isIgProfilePath, shortcodeToId } from '@/utils/ig';

// Isolated world: calls IG's private REST API, injects the download buttons,
// and writes files. Media ids come from the __igdl_id attribute stamped by the
// MAIN-world tagger (ig-tagger.content.ts). Cross-origin media fetches are
// delegated to the background service worker (MV3 content scripts get no CORS
// bypass from host_permissions; the background does).
//
// Scope: single posts (feed article, post page, profile/explore grid tiles),
// stories (current one / all), and whole-account download (Chromium only, via
// the File System Access API). Excluded from Firefox — it relies on the
// MAIN-world tagger which Firefox MV2 cannot run.
export default defineContentScript({
  matches: ['*://*.instagram.com/*'],
  exclude: ['firefox'],
  cssInjectionMode: 'manifest',
  runAt: 'document_idle',
  main() {
    const t = browser.i18n.getMessage;
    const log = (...a: any[]) => console.log('%c[IGDL]', 'color:#e1306c;font-weight:bold', ...a);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const APP_ID_FALLBACK = '936619743392459';

    interface MediaItem {
      id: string;
      pk?: string;
      username: string;
      taken_at: number;
      url: string;
    }

    // ── IG API ──
    function getHeaders() {
      return {
        'x-ig-app-id': sessionStorage.getItem('__ig_app_id') || APP_ID_FALLBACK,
        'x-ig-www-claim':
          sessionStorage.getItem('__ig_www_claim') ||
          sessionStorage.getItem('www-claim-v2') ||
          '0',
      };
    }

    // Same-origin (www.instagram.com) so no CORS issue — kept in the content
    // script to reuse the page's cookies + session app-id. Retries on 429 with
    // backoff so a mid-pagination rate-limit doesn't kill a whole-account run.
    async function apiGet(url: string, attempt = 0): Promise<any> {
      const res = await fetch(url, { headers: getHeaders(), credentials: 'include' });
      if (res.status === 429) {
        if (attempt < 3) {
          await sleep(30000 * (attempt + 1));
          return apiGet(url, attempt + 1);
        }
        throw new Error('Instagram rate-limited the request (429) — try again later.');
      }
      if (!res.ok) throw new Error(`API responded ${res.status}`);
      return res.json();
    }

    // pick the highest-resolution candidate from one media / carousel child
    function bestUrl(node: any): string {
      const candidates = node.video_versions || node.image_versions2?.candidates || [];
      let best: any = null;
      for (const c of candidates) if (!best || c.width * c.height > best.width * best.height) best = c;
      if (!best) throw new Error('No media URL found (response shape may have changed).');
      return best.url;
    }

    async function getPostItems(mediaId: string): Promise<MediaItem[]> {
      const json = await apiGet(`https://www.instagram.com/api/v1/media/${mediaId}/info/`);
      const media = json.items?.[0];
      if (!media) throw new Error('Post not found.');
      const username = media.user?.username || 'unknown';
      const children = media.carousel_media || [media];
      return children.map((c: any) => ({
        id: c.id, username, taken_at: c.taken_at, url: bestUrl(c),
      }));
    }

    async function getAccount(username: string) {
      const json = await apiGet(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`,
      );
      const u = json.data.user;
      return {
        id: u.id as string,
        username: u.username as string,
        totalPosts: (u.edge_owner_to_timeline_media?.count as number) || 0,
      };
    }

    // one feed page (12 posts) → { items, nextMaxId }
    async function getFeedPage(username: string, maxId?: string) {
      const json = await apiGet(
        `https://www.instagram.com/api/v1/feed/user/${username}/username/?count=12${maxId ? '&max_id=' + maxId : ''}`,
      );
      const items: MediaItem[] = [];
      for (const media of json.items || []) {
        const uname = media.user?.username || username;
        const children = media.carousel_media || [media];
        for (const c of children)
          items.push({ id: c.id, username: uname, taken_at: c.taken_at, url: bestUrl(c) });
      }
      return { items, nextMaxId: json.more_available ? (json.next_max_id as string) : undefined };
    }

    async function getReelItems(reelId: string): Promise<MediaItem[]> {
      const json = await apiGet(
        `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(reelId)}`,
      );
      const reel = json.reels?.[reelId] || json.reels_media?.[0];
      if (!reel) throw new Error('Story not found.');
      const username = reel.user?.username || 'story';
      return (reel.items || []).map((it: any) => ({
        pk: it.pk, id: it.pk, username, taken_at: it.taken_at, url: bestUrl(it),
      }));
    }

    // ── download ──
    function buildFilename(item: MediaItem) {
      const ext = (item.url.match(/\.([0-9a-z]+)(?:[?#]|$)/i) || [, 'jpg'])[1];
      return `${item.username}_${item.taken_at}_${item.id}.${ext}`.replace(/[<>:"/\\|?*]/g, '');
    }

    // Save to the Downloads folder via the background service worker (it holds
    // the host_permissions needed to fetch IG-CDN media in MV3).
    async function saveMedia(item: MediaItem) {
      const res = await browser.runtime.sendMessage({
        type: 'download-media',
        url: item.url,
        filename: buildFilename(item),
      });
      if (res?.error) throw new Error(res.error);
    }

    function base64ToBytes(b64: string) {
      const bin = atob(b64);
      const out = new Uint8Array(new ArrayBuffer(bin.length));
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }

    // ── whole-account download: remember the target folder across sessions ──
    // Chromium only (Brave needs a flag). queryPermission/requestPermission are
    // still a proposal, so they are accessed loosely.
    function idb(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<any> {
      return new Promise((resolve, reject) => {
        const open = indexedDB.open('igdl', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('kv');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const store = open.result.transaction('kv', mode).objectStore('kv');
          const req = fn(store);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        };
      });
    }
    const idbGet = (k: string) => idb('readonly', (s) => s.get(k));
    const idbSet = (k: string, v: any) => idb('readwrite', (s) => s.put(v, k));

    const supportsFsAccess = 'showDirectoryPicker' in self;

    async function getDownloadDir(): Promise<FileSystemDirectoryHandle> {
      if (!supportsFsAccess) {
        throw new Error('This browser cannot choose a folder (Chromium only).');
      }
      const opts = { mode: 'readwrite' } as const;
      const stored = (await idbGet('dir').catch(() => null)) as FileSystemDirectoryHandle | null;
      if (stored) {
        try {
          const granted =
            (await (stored as any).queryPermission(opts)) === 'granted' ||
            (await (stored as any).requestPermission(opts)) === 'granted';
          // queryPermission can still report "granted" for a folder that was
          // since deleted/moved — reading an entry throws NotFoundError then.
          // Probe before trusting it, otherwise fall through to a fresh pick.
          if (granted) {
            await stored.keys().next();
            return stored;
          }
        } catch (e) {
          log('stored folder unusable, re-picking:', e);
        }
      }
      // Must stay within the button click's transient activation (~5s). The idb
      // probe above is fast, but surface the gesture/cancel errors clearly.
      try {
        const handle = await showDirectoryPicker({ id: 'igdl', mode: 'readwrite', startIn: 'downloads' });
        await idbSet('dir', handle).catch(() => {});
        return handle;
      } catch (e: any) {
        if (e?.name === 'AbortError') throw new Error('Folder selection cancelled.');
        if (e?.name === 'SecurityError') throw new Error('Please click the button again to choose a folder.');
        throw e;
      }
    }

    // save into the chosen folder, skipping files that already exist
    async function saveToDir(item: MediaItem, subdir: FileSystemDirectoryHandle): Promise<'new' | 'skip'> {
      const fh = await subdir.getFileHandle(buildFilename(item), { create: true });
      if ((await fh.getFile()).size > 0) return 'skip';
      const res = await browser.runtime.sendMessage({ type: 'fetch-media', url: item.url });
      if (res?.error) throw new Error(res.error);
      const w = await fh.createWritable();
      await w.write(new Blob([base64ToBytes(res.base64)]));
      await w.close();
      if (item.url.includes('.mp4?')) await sleep(300); // ease IG rate-limit after a video
      return 'new';
    }

    // ── status toast ──
    let toastEl: HTMLDivElement | undefined;
    let toastTimer: ReturnType<typeof setTimeout>;
    function toast(msg: string, keep?: boolean) {
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.className = 'igdl-toast';
        document.body.appendChild(toastEl);
      }
      toastEl.textContent = msg;
      toastEl.style.display = 'block';
      clearTimeout(toastTimer);
      if (!keep) toastTimer = setTimeout(() => (toastEl!.style.display = 'none'), 4000);
    }

    // ── find media id for an element ──
    // Primary path is the fiber-stamped __igdl_id; the shortcode fallback keeps
    // things working when a layout change breaks fiber walking, by reading the
    // permalink from the element's own href, a descendant/ancestor link, or the
    // page URL.
    function idFromElement(el: Element): string | null {
      const direct = el.getAttribute('__igdl_id');
      if (direct) return direct;
      const tagged = el.querySelector?.('[__igdl_id]') || el.closest?.('[__igdl_id]');
      if (tagged) return tagged.getAttribute('__igdl_id');
      const href =
        el.getAttribute?.('href') ||
        el.querySelector?.('a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]')?.getAttribute('href') ||
        location.pathname;
      const sc = href?.match(/\/(?:p|reel|tv)\/([^/?#]+)/)?.[1];
      try {
        return sc ? shortcodeToId(sc) : null;
      } catch {
        return null;
      }
    }

    // ── download flows ──
    async function downloadPost(mediaId: string | null) {
      if (!mediaId) throw new Error('Could not determine the post id.');
      toast(t('msgFetchingPost'), true);
      const items = await getPostItems(mediaId);
      for (let i = 0; i < items.length; i++) {
        toast(`${t('msgDownloading')} ${i + 1}/${items.length}…`, true);
        await saveMedia(items[i]);
      }
      toast(`✓ ${t('msgDone')} (${items.length})`);
    }

    async function downloadStory(all: boolean) {
      const parts = location.pathname.split('/').filter(Boolean); // ["stories", a, b?]
      const a = parts[1], b = parts[2];
      let reelId: string;
      let currentPk: string | undefined;
      if (a === 'highlights') {
        reelId = 'highlight:' + b;
      } else {
        toast(t('msgFindingAccount'), true);
        reelId = (await getAccount(a)).id;
        currentPk = b;
      }
      if (!all && !currentPk) {
        const v = document.querySelector('video[__igdl_id], img[__igdl_id]');
        currentPk = v?.getAttribute('__igdl_id') ?? undefined;
      }

      toast(t('msgFetchingStory'), true);
      let items = await getReelItems(reelId);
      if (!all && currentPk) items = items.filter((it) => String(it.pk) === String(currentPk));
      if (items.length === 0) throw new Error(t('msgNoStory'));

      for (let i = 0; i < items.length; i++) {
        toast(`${t('msgDownloading')} ${i + 1}/${items.length}…`, true);
        await saveMedia(items[i]);
      }
      toast(`✓ ${t('msgDone')} (${items.length})`);
    }

    async function downloadAccount() {
      const username = location.pathname.split('/').filter(Boolean)[0];
      if (!username) throw new Error('Could not determine the account name.');

      // Pick the folder first, while the click's user activation is still live.
      toast(t('msgChoosingFolder'), true);
      const dir = await getDownloadDir();
      const acc = await getAccount(username);
      const subdir = await dir.getDirectoryHandle(acc.username, { create: true });

      // Page through the feed and save each page as it arrives — no giant
      // in-memory buffer, and a later-page failure keeps what's already saved.
      let maxId: string | undefined;
      let done = 0, created = 0, skipped = 0;
      do {
        const page = await getFeedPage(username, maxId);
        for (const item of page.items) {
          done++;
          toast(`${t('msgDownloading')} ${done}/${acc.totalPosts} (${t('msgNew')} ${created}, ${t('msgSkipped')} ${skipped})…`, true);
          try {
            (await saveToDir(item, subdir)) === 'new' ? created++ : skipped++;
          } catch (e) { log('skipped failed file:', e); }
        }
        maxId = page.nextMaxId;
        if (maxId) await sleep(1500); // throttle to avoid rate-limit
      } while (maxId);

      toast(`✓ ${t('msgDone')}: ${t('msgNew')} ${created}, ${t('msgSkipped')} ${skipped}`);
    }

    // wrap handler: block default nav + surface errors
    function guard(fn: () => Promise<void>) {
      return async (ev?: Event) => {
        if (ev) { ev.preventDefault(); ev.stopPropagation(); }
        try { await fn(); }
        catch (e: any) { log('ERROR:', e); toast('✗ ' + (e?.message ?? e)); }
      };
    }

    // ── injected buttons ──
    function makeBtn(cls: string, title: string, onClick: () => Promise<void>) {
      const b = document.createElement('button');
      b.className = 'igdl-btn ' + cls;
      b.title = title;
      b.textContent = '⬇';
      b.onclick = guard(onClick);
      return b;
    }

    // buttons on posts (feed / post page)
    function injectPostButtons() {
      for (const article of document.querySelectorAll<HTMLElement>('article[__igdl_id]')) {
        if (article.dataset.igdlBtn) continue;
        article.dataset.igdlBtn = '1';
        if (getComputedStyle(article).position === 'static') article.style.position = 'relative';
        article.appendChild(
          makeBtn('igdl-corner', t('postDownloadTitle'), () => downloadPost(idFromElement(article))),
        );
      }
    }

    // buttons on grid tiles (profile / explore / saved)
    function injectGridButtons() {
      const sel = 'a._a6hd[__igdl_id], a[href^="/p/"][__igdl_id], a[href^="/reel/"][__igdl_id]';
      for (const tile of document.querySelectorAll<HTMLElement>(sel)) {
        if (tile.dataset.igdlBtn) continue;
        tile.dataset.igdlBtn = '1';
        if (getComputedStyle(tile).position === 'static') tile.style.position = 'relative';
        tile.appendChild(makeBtn('igdl-corner', t('postDownloadTitle'), () => downloadPost(idFromElement(tile))));
      }
    }

    // ── floating bar (story) ──
    interface BarSpec {
      kind: string;
      items: { label: string; onClick: () => Promise<void> }[];
    }
    function setFloatingBar(spec: BarSpec | null) {
      let bar = document.getElementById('igdl-bar');
      if (!spec) { bar?.remove(); return; }
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'igdl-bar';
        document.body.appendChild(bar);
      }
      if (bar.dataset.kind === spec.kind) return; // rebuild only when the set changes
      bar.dataset.kind = spec.kind;
      bar.innerHTML = '';
      for (const b of spec.items) {
        const el = document.createElement('button');
        el.className = 'igdl-fbtn';
        el.textContent = b.label;
        el.onclick = guard(b.onClick);
        bar.appendChild(el);
      }
    }

    const isStory = () => /^\/stories\//.test(location.pathname);

    function updateFloatingBar() {
      if (isStory()) {
        setFloatingBar({
          kind: 'story',
          items: [
            { label: t('storyThis'), onClick: () => downloadStory(false) },
            { label: t('storyAll'), onClick: () => downloadStory(true) },
          ],
        });
      } else if (isIgProfilePath(location.pathname) && supportsFsAccess) {
        setFloatingBar({
          kind: 'account',
          items: [{ label: t('accountAll'), onClick: () => downloadAccount() }],
        });
      } else {
        setFloatingBar(null);
      }
    }

    // ── router ──
    function refreshUI() {
      try {
        injectPostButtons();
        injectGridButtons();
        updateFloatingBar();
      } catch (e) { log('refreshUI error:', e); }
    }

    let debounce: ReturnType<typeof setTimeout>;
    const scheduleRefresh = () => {
      clearTimeout(debounce);
      debounce = setTimeout(refreshUI, 300);
    };

    window.addEventListener('locationchange', () => {
      document.getElementById('igdl-bar')?.removeAttribute('data-kind'); // force rebuild
      scheduleRefresh();
    });
    new MutationObserver(scheduleRefresh).observe(document.body, { childList: true, subtree: true });

    refreshUI();
    log('ready');
  },
});
