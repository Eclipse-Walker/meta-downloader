// Shared Instagram URL/id helpers used by both the background script and the
// content scripts. Keeping the reserved-segment list in one place avoids the
// background and content copies drifting apart.

// Path segments that are IG features, not usernames.
export const IG_RESERVED = [
  'p',
  'reel',
  'reels',
  'tv',
  'stories',
  'explore',
  'direct',
  'accounts',
  'locations',
  'tags',
];

// True when the path is a bare profile page (instagram.com/<username>).
export function isIgProfilePath(pathname: string): boolean {
  const segments = pathname.split('/').filter(Boolean);
  return segments.length === 1 && !IG_RESERVED.includes(segments[0]);
}

// Parse the username from any IG URL, or throw if it is not a profile page.
// Stories carry the username second: instagram.com/stories/<user>/<id>.
export function parseIgUsername(link: string): string {
  const segments = new URL(link).pathname.split('/').filter(Boolean);
  const candidate = segments[0] === 'stories' ? segments[1] : segments[0];
  if (!candidate || IG_RESERVED.includes(candidate) || !/^[A-Za-z0-9_.]+$/.test(candidate)) {
    throw new Error(`Not an Instagram profile page: ${link}`);
  }
  return candidate;
}

// shortcode (base64) → numeric media id. Fallback when the fiber-stamped
// __igdl_id attribute is absent (e.g. a post page, or a Chromium layout change
// that breaks fiber walking).
export function shortcodeToId(shortcode: string): string {
  if (shortcode.length > 28) shortcode = shortcode.substr(0, shortcode.length - 28);
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const alphabet = lower.toUpperCase() + lower + '0123456789-_';
  let id = 0n;
  for (const ch of shortcode) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error(`Invalid shortcode character: ${ch}`);
    id = id * 64n + BigInt(v);
  }
  return id.toString();
}
