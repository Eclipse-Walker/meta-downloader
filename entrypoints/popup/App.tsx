import { useEffect, useState } from 'react';
import './App.css';

type Platform = 'instagram' | 'tiktok' | null;

const t = browser.i18n.getMessage;

function detectPlatform(url?: string): Platform {
  if (!url) return null;
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('tiktok.com')) return 'tiktok';
  return null;
}

function App() {
  const [platform, setPlatform] = useState<Platform>(null);
  const [status, setStatus] = useState('');
  const [isError, setIsError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    browser.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => setPlatform(detectPlatform(tab?.url)));
  }, []);

  async function download() {
    setBusy(true);
    setStatus('');
    setIsError(false);
    try {
      const response = await browser.runtime.sendMessage({ type: 'download-profile-picture' });
      if (response?.error) throw new Error(response.error);
      setStatus(t('downloaded'));
    } catch (error) {
      setIsError(true);
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>{t('extName')}</h1>
      {platform ? (
        <button type="button" onClick={download} disabled={busy}>
          {busy ? t('downloading') : t('downloadButton')}
        </button>
      ) : (
        <p className="status">{t('openProfileHint')}</p>
      )}
      {status && <p className={`status${isError ? ' error' : ''}`}>{status}</p>}
    </>
  );
}

export default App;
