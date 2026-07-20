import { useEffect, useState } from 'react';
import './App.css';
import {
  DEFAULT_FLAGS,
  DEFAULT_THEME,
  loadFlags,
  loadTheme,
  saveFlags,
  saveTheme,
  type FeatureFlags,
  type Theme,
} from '@/utils/flags';

type Platform = 'instagram' | 'tiktok' | null;
type MsgKey = Parameters<typeof browser.i18n.getMessage>[0];

const t = browser.i18n.getMessage;

const THEMES: { value: Theme; label: MsgKey }[] = [
  { value: 'system', label: 'themeSystem' },
  { value: 'light', label: 'themeLight' },
  { value: 'dark', label: 'themeDark' },
];

function detectPlatform(url?: string): Platform {
  if (!url) return null;
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('tiktok.com')) return 'tiktok';
  return null;
}

const FLAG_ROWS: { key: keyof FeatureFlags; label: MsgKey; desc: MsgKey }[] = [
  { key: 'profilePic', label: 'flagProfilePicLabel', desc: 'flagProfilePicDesc' },
  { key: 'post', label: 'flagPostLabel', desc: 'flagPostDesc' },
  { key: 'story', label: 'flagStoryLabel', desc: 'flagStoryDesc' },
  { key: 'account', label: 'flagAccountLabel', desc: 'flagAccountDesc' },
];

function App() {
  const [platform, setPlatform] = useState<Platform>(null);
  const [status, setStatus] = useState('');
  const [isError, setIsError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flags, setFlags] = useState<FeatureFlags>(DEFAULT_FLAGS);
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);

  useEffect(() => {
    browser.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => setPlatform(detectPlatform(tab?.url)))
      .catch(() => setPlatform(null));
    loadFlags().then(setFlags).catch(() => {});
    loadTheme().then(applyTheme).catch(() => {});
  }, []);

  function applyTheme(next: Theme) {
    setThemeState(next);
    document.documentElement.setAttribute('data-theme', next);
  }

  function changeTheme(next: Theme) {
    applyTheme(next);
    saveTheme(next).catch(() => {});
  }

  function toggle(key: keyof FeatureFlags) {
    setFlags((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      saveFlags(next).catch(() => {});
      return next;
    });
  }

  async function download() {
    setBusy(true);
    setStatus('');
    setIsError(false);
    try {
      const response = await browser.runtime.sendMessage({ type: 'download-profile-picture' });
      if (response?.error) throw new Error(response.error);
      setStatus(t('downloaded'));
    } catch (error) {
      console.warn('download failed:', error);
      setIsError(true);
      setStatus(t('downloadFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__logo" aria-hidden="true">⬇</span>
        <h1 className="app__title">{t('extName')}</h1>
      </header>

      {flags.profilePic && (
        <section className="card">
          {platform ? (
            <>
              <button className="btn-primary" type="button" onClick={download} disabled={busy}>
                {busy ? t('downloading') : t('downloadButton')}
              </button>
              {status && (
                <p className={`status${isError ? ' status--error' : ''}`}>{status}</p>
              )}
            </>
          ) : (
            <p className="hint">{t('openProfileHint')}</p>
          )}
        </section>
      )}

      <section className="settings">
        <h2 className="settings__heading">{t('themeHeading')}</h2>
        <div className="seg" role="group">
          {THEMES.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`seg__btn${theme === opt.value ? ' seg__btn--active' : ''}`}
              aria-pressed={theme === opt.value}
              onClick={() => changeTheme(opt.value)}
            >
              {t(opt.label)}
            </button>
          ))}
        </div>
      </section>

      <section className="settings">
        <h2 className="settings__heading">{t('settingsHeading')}</h2>
        {FLAG_ROWS.map((row) => (
          <label className="toggle" key={row.key}>
            <span className="toggle__text">
              <span className="toggle__label">{t(row.label)}</span>
              <span className="toggle__desc">{t(row.desc)}</span>
            </span>
            <input
              type="checkbox"
              className="toggle__input"
              checked={flags[row.key]}
              onChange={() => toggle(row.key)}
            />
            <span className="toggle__track" aria-hidden="true" />
          </label>
        ))}
      </section>
    </div>
  );
}

export default App;
