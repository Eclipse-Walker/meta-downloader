// Per-download-type feature flags, shared by the popup (which toggles them),
// the content scripts (which gate button injection on them), and the
// background context menu. Stored in browser.storage.local; all default on.

export interface FeatureFlags {
  profilePic: boolean; // profile-picture download (popup button + context menu)
  post: boolean; // post/carousel download buttons
  story: boolean; // story download buttons
  account: boolean; // whole-account download button
}

export const DEFAULT_FLAGS: FeatureFlags = {
  profilePic: true,
  post: true,
  story: true,
  account: true,
};

const KEY = 'featureFlags';

export async function loadFlags(): Promise<FeatureFlags> {
  try {
    const stored = await browser.storage.local.get(KEY);
    return { ...DEFAULT_FLAGS, ...(stored[KEY] as Partial<FeatureFlags> | undefined) };
  } catch {
    return { ...DEFAULT_FLAGS };
  }
}

export async function saveFlags(flags: FeatureFlags): Promise<void> {
  await browser.storage.local.set({ [KEY]: flags });
}

// Subscribe to changes (e.g. the popup toggling a flag while a tab is open).
// Returns an unsubscribe function.
export function onFlagsChanged(cb: (flags: FeatureFlags) => void): () => void {
  const listener = (changes: Record<string, Browser.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[KEY]) {
      cb({ ...DEFAULT_FLAGS, ...(changes[KEY].newValue as Partial<FeatureFlags> | undefined) });
    }
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

// ── popup theme preference ──
// 'system' follows the browser/OS (prefers-color-scheme); 'light'/'dark'
// force it. Only affects the popup surface — the on-page IG buttons follow
// IG's own theme.
export type Theme = 'system' | 'light' | 'dark';
export const DEFAULT_THEME: Theme = 'system';
const THEME_KEY = 'theme';

export async function loadTheme(): Promise<Theme> {
  try {
    const stored = await browser.storage.local.get(THEME_KEY);
    return (stored[THEME_KEY] as Theme | undefined) ?? DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export async function saveTheme(theme: Theme): Promise<void> {
  await browser.storage.local.set({ [THEME_KEY]: theme });
}
