# Meta Downloader

Chrome/Firefox extension to view & download Instagram and TikTok profile pictures in full size. Built with [WXT](https://wxt.dev) + React.

## Usage

### Profile pictures

- **Toolbar popup** — open an Instagram or TikTok profile, click the extension icon, then **Download profile picture**. The image is saved as `<username>.jpg`.
- **Context menu** — right-click anywhere on the profile page and choose **Meta Downloader** to open the full-size picture in a new tab.

### Instagram posts & stories

On-page buttons injected while browsing instagram.com (must be logged in):

| Where | Button | Action |
| --- | --- | --- |
| Feed post / post page (single image/video) | ⬇ next to the Save (bookmark) button | Download that post |
| Feed post / post page (carousel) | ⬇ / ⬇⬇ next to the Save (bookmark) button | Download the currently-viewed slide / download every slide |
| Profile / explore / saved grid | ⬇ on the tile (on hover) | Download that post |
| Story page | ⬇ / ⬇⬇ next to the mute/pause/more controls (falls back to a floating bottom-right bar if that row can't be found) | Download the current story or the whole reel |
| Profile page | ⬇ after the Follow/Message buttons (falls back to a floating bottom-right button if that row can't be found) | Pick a folder, then download every post (skips files already saved) |

Posts and stories save to your normal Downloads folder as `<username>_<taken_at>_<id>.<ext>`. Whole-account download saves into a folder you pick via the File System Access API (Chromium only; the handle is remembered in IndexedDB so you only choose once).

### Settings (popup)

The toolbar popup doubles as a settings panel:

- **Feature toggles** — turn each download type on or off individually: profile picture (popup + context menu), posts, stories, whole account. All default on. Disabling a type immediately removes its on-page buttons in any open tab (no reload needed). Stored in `browser.storage.local`.
- **Theme** — System / Light / Dark. Defaults to **System** (follows the browser's `prefers-color-scheme`) and only affects the popup itself; the on-page buttons follow Instagram's own theme.

### Localization

UI strings are localized with the native `browser.i18n` API (`public/_locales/`, currently **en** and **th**). The displayed language follows the browser's display language — not Instagram's UI language — since that's what `chrome.i18n` reads.

### How it resolves the Instagram image

Tries the highest-resolution source first and falls back down the chain:

1. Instagram's web GraphQL (`PolarisProfilePageContentQuery`) — full-resolution HD image, requires an active IG login. The request runs inside the IG tab via `scripting.executeScript` so it inherits the page's cookies and session tokens.
2. Private mobile `/users/<id>/info/` endpoint — HD but often center-cropped. A dynamic `declarativeNetRequest` rule (set at runtime in the background script) spoofs the mobile app User-Agent.
3. URLs already present in the web profile response — last resort, low-resolution.

The GraphQL `doc_id` is rotated by Meta whenever their web bundle redeploys, so step 1 is expected to break periodically; the fallback chain keeps the extension working.

TikTok avatars are scraped from the profile page HTML (`avatarLarger`).

## Development

```sh
bun install
bun run dev            # Chrome with hot reload
bun run dev:firefox    # Firefox with hot reload
```

## Build

```sh
bun run build          # Chrome (MV3)  → .output/chrome-mv3
bun run build:firefox  # Firefox (MV2) → .output/firefox-mv2
bun run zip            # distributable zip (add :firefox for Firefox)
bun run compile        # type-check only
```

## Releases (CI)

Two GitHub Actions workflows automate versioning and publishing:

- **Bump Version** (`workflow_dispatch`) — pick `patch`/`minor`/`major`; runs `npm version` (updates [package.json](package.json), commits, tags `vX.Y.Z`), pushes, then dispatches the release workflow on the new tag. WXT derives the manifest `version` from `package.json`, so there's no separate manifest to bump.
- **Release** (`on: push` tag `v*`, or `workflow_dispatch`) — type-checks, builds Chrome + Firefox zips, and creates a GitHub Release with `chrome`, `firefox`, and `sources` zips attached.

### Loading an unpacked build

- **Chrome** — `chrome://extensions` → enable Developer mode → **Load unpacked** → select `.output/chrome-mv3`.
- **Firefox** — `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → select `.output/firefox-mv2/manifest.json`. Installing the `.zip` directly fails with an "appears to be corrupt" error — that means *unsigned*, not broken; permanent installs require signing via addons.mozilla.org.

## Project structure

| Path | Purpose |
| --- | --- |
| [entrypoints/background.ts](entrypoints/background.ts) | Profile-pic resolvers (IG/TikTok), context menu, and the message bridge that fetches/downloads IG-CDN media on the content scripts' behalf (MV3 CORS) |
| [entrypoints/popup/](entrypoints/popup/) | Toolbar popup (React): profile-pic download, feature toggles, theme selector |
| [entrypoints/ig-tagger.content.ts](entrypoints/ig-tagger.content.ts) | MAIN-world content script: SPA history hook + stamps media ids from React fiber onto `__igdl_id` attributes |
| [entrypoints/ig-downloader.content/](entrypoints/ig-downloader.content/) | Isolated content script: IG API calls, post/story/account download, injected buttons |
| [utils/ig.ts](utils/ig.ts) | Shared IG helpers: username parsing, profile-path check, shortcode → media id |
| [utils/flags.ts](utils/flags.ts) | Feature flags + theme preference (storage-backed, shared by popup/content/background) |
| [public/_locales/](public/_locales/) | i18n messages (en, th) |
| [wxt.config.ts](wxt.config.ts) | Manifest: permissions (incl. `storage`), host permissions, locale placeholders |

> **Firefox note:** post/story/account download relies on reading React fiber from a `world: "MAIN"` content script, which Firefox only honors on MV3 (128+) — the MV2 Firefox build cannot run it. Both content scripts are therefore **excluded from the Firefox build** (`exclude: ['firefox']`), so the injected buttons never appear there. Profile-picture download (popup + context menu) works on Firefox as normal. Whole-account download additionally needs the File System Access API and is Chromium-only even on Chrome-family browsers (Brave requires a flag); the button is hidden when the API is unavailable.
