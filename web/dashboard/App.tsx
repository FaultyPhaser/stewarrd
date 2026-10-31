import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createApi } from '../shared/api';
import { errorMessage, userName } from '../shared/format';
import type { Me } from '../shared/types';
import { AdminPanel, MaintenancePanel, SettingsPanel } from './components/AdminPanel';
import { DevPanel } from './components/DevPanel';
import { LoginPanel } from './components/LoginPanel';
import { Flagged, MyMedia } from './components/MediaSections';
import { AppCtx, type AppContext, type MessageLink, type Tab } from './context';
import { importInBatches } from './importBatches';
import { finishPlexLogin, needsInitialImport } from './session';
import type { Flags, ImportResult } from './types';

export function App({ flags }: { flags: Flags }) {
  const api = useMemo(() => createApi(flags.apiBase), [flags.apiBase]);
  const [me, setMe] = useState<Me | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [balanceText, setBalanceText] = useState('Loading…');
  const [message, setMessage] = useState<{ text: string; isError: boolean; link?: MessageLink }>({ text: '', isError: false });
  const [version, setVersion] = useState(0);
  const [tab, setTabState] = useState<Tab>(() => {
    const saved = sessionStorage.getItem('tab');
    return saved === 'maintenance' || saved === 'admin' || saved === 'settings' ? saved : 'media';
  });
  const importing = useRef(false);

  const say = useCallback((text: string, isError = false, link?: MessageLink) => setMessage({ text, isError, link }), []);

  const refresh = useCallback(async () => {
    const next = await api.get<Me>('/user/credits');
    setMe(next);
    setBalanceText(next.credits === null ? '🪙 Credits: unlimited (admin)' : `🪙 Credits: ${next.credits}`);
    setVersion((v) => v + 1);
    return next;
  }, [api]);

  const setTab = useCallback((next: Tab) => {
    sessionStorage.setItem('tab', next);
    setTabState(next);
  }, []);

  const guard = useCallback((fn: () => Promise<unknown> | unknown) => async () => {
    try {
      await fn();
    } catch (err) {
      say(errorMessage(err), true);
    }
  }, [say]);

  const actAs = useCallback(async (userId: number | null) => {
    await api.post('/admin/act-as', { userId });
    setTab('media'); // start on the user's own view
    await refresh();
    say(userId === null ? 'Back to your own account.' : 'Now acting as that user. Use "Stop acting" to return.');
  }, [api, refresh, say, setTab]);

  /** Pulls users and ownership from Seerr in batches. Only the first batch of a reset erases data. */
  const runImport = useCallback(async (reset: boolean) => {
    if (importing.current) return;
    importing.current = true;
    try {
      const total = await importInBatches(
        (body) => api.post<ImportResult>('/admin/import', body),
        reset,
        (t) => say(`Importing from Seerr… ${t.imported} item(s) so far.`),
      );
      say(`Import complete: ${total.imported} item(s), ${total.users} user(s) (${total.adminOwned} assigned to admin). `
        + `Charged ${total.charged} credit(s); ${total.overdrawn} user(s) below zero.`);
      await refresh();
    } finally {
      importing.current = false;
    }
  }, [api, refresh, say]);

  useEffect(() => {
    const maybeInitialImport = async (who: Me) => {
      try {
        if (!(await needsInitialImport(api, who, flags.fakeLogin))) return;
        say('First-time setup: importing from Seerr…');
        await runImport(false);
      } catch (err) {
        say(`Initial import failed: ${errorMessage(err)}`, true);
      }
    };

    (async () => {
      try {
        const who = await refresh();
        setSignedIn(true);
        await maybeInitialImport(who);
        return;
      } catch (err) {
        setBalanceText('Signed out');
        if (flags.fakeLogin) { say(`${errorMessage(err)}. Seed demo data and pick a user below.`, true); return; }
        setSignedIn(false);
      }
      try {
        if (await finishPlexLogin(api)) {
          const who = await refresh();
          setSignedIn(true);
          say('Signed in.');
          await maybeInitialImport(who);
        }
      } catch (err) {
        say(errorMessage(err), true);
      }
    })();
  }, []);

  const ctx: AppContext = { flags, api, me, version, say, refresh, setTab, actAs, runImport, guard };
  const showMain = flags.fakeLogin || signedIn === true;
  const isAdmin = Boolean(me?.isAdmin);
  const activeTab: Tab = isAdmin ? tab : 'media';
  const tabs: { id: Tab; label: string }[] = [
    { id: 'media', label: 'Media' },
    { id: 'maintenance', label: 'Maintenance' },
    { id: 'admin', label: 'Admin' },
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <AppCtx.Provider value={ctx}>
      <main>
        <header>
          <h1 class="brand"><img src={`${flags.assetBase}/images/wordmark.png`} alt="Stewarrd" width={600} height={310} /></h1>
          <div id="balance" class="badge">{balanceText}</div>
          {!flags.fakeLogin && signedIn === true && (
            <button id="logout" type="button" onClick={async () => { await api.post('/auth/logout').catch(() => {}); window.location.reload(); }}>
              Sign out
            </button>
          )}
        </header>
        <p id="message" role="status" class={message.isError ? 'error' : undefined}>
          {message.text}
          {message.link && <>{' '}<a href={message.link.href} download>{message.link.label}</a></>}
        </p>
        {me?.actingAs && (
          <div id="actas-banner" class="badge">
            <span>{`Acting as ${userName({ id: me.userId, username: me.username })}. `}</span>
            <button type="button" onClick={guard(() => actAs(null))}>Stop acting</button>
          </div>
        )}
        {!flags.fakeLogin && signedIn === false && <LoginPanel />}
        {flags.fakeLogin && <DevPanel />}
        {showMain && isAdmin && (
          <nav class="tabs" role="tablist">
            {tabs.map((t) => (
              <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={activeTab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </nav>
        )}
        {showMain && activeTab === 'media' && <><MyMedia /><Flagged /></>}
        {showMain && isAdmin && activeTab === 'maintenance' && <MaintenancePanel />}
        {showMain && isAdmin && activeTab === 'admin' && <AdminPanel />}
        {showMain && isAdmin && activeTab === 'settings' && <SettingsPanel />}
      </main>
    </AppCtx.Provider>
  );
}
