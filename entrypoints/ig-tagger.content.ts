// MAIN world: runs in the page's own JS context so it can read React fiber
// internals (an isolated content script cannot). Two jobs:
//   1. history hook → fire a "locationchange" event (IG is a SPA)
//   2. read each media's numeric id from its fiber → stamp it as an
//      __igdl_id attribute that the isolated downloader reads back.
// ponytail: fiber-walk + selectors are the fragile part — when IG changes
// its layout this is what breaks first. Fix it here.
//
// Chromium only: world:"MAIN" is honored on MV3, but Firefox builds are MV2
// where it is silently ignored (the script would run isolated and read no
// fiber), so this entrypoint is excluded from the Firefox build entirely.
export default defineContentScript({
  matches: ['*://*.instagram.com/*'],
  exclude: ['firefox'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    const isNumericId = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v);

    // ── 1) SPA history hook ──
    const fireLocationChange = () => window.dispatchEvent(new Event('locationchange'));
    for (const method of ['pushState', 'replaceState'] as const) {
      const original = history[method];
      history[method] = function (this: History, ...args: any[]) {
        const r = original.apply(this, args as any);
        fireLocationChange();
        return r;
      } as any;
    }
    window.addEventListener('popstate', fireLocationChange);

    // ── 2) fiber tagging ──
    function findMediaId(element: any): string | undefined {
      if (!element) return;
      let id: any;
      for (const key of Object.keys(element)) {
        if (!key.startsWith('__reactFiber$')) continue;
        const fiber = element[key];

        try { const v = fiber.return.memoizedProps.id; if (v && isNumericId(v)) return v; } catch {}
        if (fiber.child) try { id = fiber.child.memoizedProps.id; if (id && isNumericId(id)) return id; } catch {}
        if (fiber.return) {
          try { id = fiber.return.memoizedProps.post.id; if (id) return id; } catch {}
          try { id = fiber.return.memoizedProps.postId; if (id) return id; } catch {}
        }
        if (fiber.return && fiber.return.return) try {
          id = fiber.return.return.memoizedProps.videoFBID; if (id) return id;
          id = fiber.return.return.memoizedProps.id; if (id && isNumericId(id)) return id;
        } catch {}
        try {
          if (fiber.return.return.return.return.return.memoizedProps.id &&
              ((id = fiber.return.return.return.return.return.memoizedProps.id), id && isNumericId(id))) return id;
        } catch {}
        try {
          if (fiber.return.return.return.return.return.return.key &&
              (id = fiber.return.return.return.return.return.return.key)) return id.split('_')[0];
        } catch {}
        try {
          if (fiber.return.return.return.return.return.return.return.return.key &&
              (id = fiber.return.return.return.return.return.return.return.return.key)) return id.split('_')[0];
        } catch {}

        if (((id = walkForId(fiber, 20, 0)), id && /^\d+$/.test(id))) return id;
        if ((id = walkForKey(fiber, 20, 0))) {
          if (/^\d+_\d+$/.test(id)) return id.split('_')[0];
          if (/^\d+$/.test(id)) return id;
        }
      }
    }

    function walkForId(fiber: any, max: number, depth = 0): any {
      const p = fiber.memoizedProps;
      if (p && p.id) return p.id;
      if (p && p.post && p.post.id) return p.post.id;
      if (p && p.media && p.media.pk) return p.media.pk;
      if (p && p.postId) return p.postId;
      if (fiber.id) return fiber.id;
      if (depth >= max) return fiber.memoizedProps.id;
      return walkForId(fiber.return, max, depth + 1);
    }

    function walkForKey(fiber: any, max: number, depth = 0): any {
      if (fiber.key || depth >= max) return fiber.key;
      return walkForKey(fiber.return, max, depth + 1);
    }

    function tagMediaElements(root: any) {
      if (!root.querySelectorAll) return;
      const tag = (sel: string) => {
        for (const el of root.querySelectorAll(sel)) {
          if (el.hasAttribute('__igdl_id')) continue; // already tagged — skip the fiber walk
          const id = findMediaId(el);
          if (id && isNumericId(id)) el.setAttribute('__igdl_id', id);
        }
      };
      tag('article');
      tag('video');
      tag('a._a6hd');
      tag('._aatk._aiao > div');
      for (const img of root.querySelectorAll('img')) {
        if (img.hasAttribute('__igdl_id')) continue;
        const p2 = img.parentNode && img.parentNode.parentNode;
        const p3 = p2 && p2.parentNode;
        let id = p2 && findMediaId(p2);
        if (!(id && isNumericId(id)) && p3) id = findMediaId(p3);
        if (id && isNumericId(id)) img.setAttribute('__igdl_id', id);
      }
    }

    // IG's feed mutates constantly; re-walking fibers on every mutation is a CPU
    // hot path. Coalesce bursts into one idle-time full scan (untagged elements
    // only, thanks to the hasAttribute guard above).
    let scanQueued = false;
    const queueScan = () => {
      if (scanQueued) return;
      scanQueued = true;
      const run = () => { scanQueued = false; tagMediaElements(document.body); };
      if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 500 });
      else setTimeout(run, 250);
    };

    const observer = new MutationObserver(queueScan);
    (function start() {
      const body = document.querySelector('body');
      if (!body) return void setTimeout(start, 50);
      observer.observe(body, { childList: true, subtree: true });
      tagMediaElements(body);
    })();
  },
});
