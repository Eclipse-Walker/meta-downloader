import './style.css';

// Isolated world: calls IG's private REST API, downloads media, and injects
// the download buttons. Media ids come from the __igdl_id attribute stamped by
// the MAIN-world tagger (ig-tagger.content.ts).
//
// Scope: single posts (feed article, post page, profile/explore grid tiles)
// and stories (current one / all). Whole-account download is intentionally
// left out. ponytail: add it back only if actually needed.
export default defineContentScript({
  matches: ['*://*.instagram.com/*'],
  cssInjectionMode: 'manifest',
  runAt: 'document_idle',
  main() {
    const t = browser.i18n.getMessage;
    const log = (...a: any[]) => console.log('%c[IGDL]', 'color:#e1306c;font-weight:bold', ...a);
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

    // shortcode (base64) → numeric media id (fallback when __igdl_id is absent)
    function shortcodeToId(shortcode: string) {
      if (shortcode.length > 28) shortcode = shortcode.substr(0, shortcode.length - 28);
      const lower = 'abcdefghijklmnopqrstuvwxyz';
      const alphabet = lower.toUpperCase() + lower + '0123456789-_';
      let id = 0n;
      for (const ch of shortcode) id = id * 64n + BigInt(alphabet.indexOf(ch));
      return id.toString();
    }

    async function apiGet(url: string) {
      const res = await fetch(url, { headers: getHeaders(), credentials: 'include' });
      if (res.status === 429) throw new Error('Instagram rate-limited the request (429) — try again shortly.');
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
      return { id: u.id as string, username: u.username as string };
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

    async function fetchBlob(url: string) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`File download failed (${res.status})`);
      return res.blob();
    }

    async function saveViaAnchor(item: MediaItem) {
      const blob = await fetchBlob(item.url);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = buildFilename(item);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
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
    function idFromElement(el: Element): string | null {
      const id = el.getAttribute('__igdl_id');
      if (id) return id;
      const tagged = el.querySelector?.('[__igdl_id]') || el.closest?.('[__igdl_id]');
      if (tagged) return tagged.getAttribute('__igdl_id');
      const m = location.pathname.match(/\/(p|reel|tv)\/([^/]+)/);
      if (m) return shortcodeToId(m[2]);
      return null;
    }

    // ── download flows ──
    async function downloadPost(mediaId: string | null) {
      if (!mediaId) throw new Error('Could not determine the post id.');
      toast(t('msgFetchingPost'), true);
      const items = await getPostItems(mediaId);
      for (let i = 0; i < items.length; i++) {
        toast(`${t('msgDownloading')} ${i + 1}/${items.length}…`, true);
        await saveViaAnchor(items[i]);
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
        await saveViaAnchor(items[i]);
      }
      toast(`✓ ${t('msgDone')} (${items.length})`);
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
        const id = article.getAttribute('__igdl_id');
        article.appendChild(
          makeBtn('igdl-corner', t('postDownloadTitle'), () => downloadPost(idFromElement(article) || id)),
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
        const id = tile.getAttribute('__igdl_id');
        tile.appendChild(makeBtn('igdl-corner', t('postDownloadTitle'), () => downloadPost(id)));
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
