# Meta Downloader

Chrome/Firefox extension to view & download Instagram and TikTok profile pictures in full size. Built with [WXT](https://wxt.dev) + React.

## Usage

- **Toolbar popup** — open an Instagram or TikTok profile, click the extension icon, then **Download profile picture**. The image is saved as `<username>.jpg`.
- **Context menu** — right-click anywhere on the profile page and choose **Meta Downloader** to open the full-size picture in a new tab.

### How it resolves the Instagram image

Tries the highest-resolution source first and falls back down the chain:

1. Instagram's web GraphQL (`PolarisProfilePageContentQuery`) — true 1080px image, requires an active IG login. The request runs inside the IG tab via `scripting.executeScript` so it inherits the page's cookies and session tokens.
2. Private mobile `/users/<id>/info/` endpoint — 1080px but often center-cropped. Uses a `declarativeNetRequest` rule ([public/rules.json](public/rules.json)) to spoof the mobile app User-Agent.
3. URLs already present in the web profile response — last resort, ~320px.

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

### Loading an unpacked build

- **Chrome** — `chrome://extensions` → enable Developer mode → **Load unpacked** → select `.output/chrome-mv3`.
- **Firefox** — `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → select `.output/firefox-mv2/manifest.json`. Installing the `.zip` directly fails with an "appears to be corrupt" error — that means *unsigned*, not broken; permanent installs require signing via addons.mozilla.org.

## Project structure

| Path | Purpose |
| --- | --- |
| [entrypoints/background.ts](entrypoints/background.ts) | All download/view logic: context menu, popup message handler, IG/TikTok resolvers |
| [entrypoints/popup/](entrypoints/popup/) | Toolbar popup (React) — download button today, settings/feature flags later |
| [public/rules.json](public/rules.json) | Static `declarativeNetRequest` User-Agent rule for the IG mobile API |
| [wxt.config.ts](wxt.config.ts) | Manifest: permissions, host permissions, DNR ruleset |
