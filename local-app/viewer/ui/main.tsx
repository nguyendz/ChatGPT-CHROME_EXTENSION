import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { isAccounts, isDetail, isGroups, isMessage, isPage, isStatus, isSummary } from '../types.ts';
import type { Account, ArchiveStatus, ConversationDetail, ConversationGroup, Page } from '../types.ts';
import { MessageContent } from './message-content.tsx';
import './style.css';

const token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', location.pathname);

async function api<T>(url: string, valid: (value: unknown) => value is T, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }, signal, cache: 'no-store',
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const message = typeof value === 'object' && value !== null && 'error' in value &&
      typeof value.error === 'object' && value.error !== null && 'message' in value.error &&
      typeof value.error.message === 'string' ? value.error.message : `Local archive request failed (${response.status}).`;
    throw new Error(message);
  }
  if (!valid(value)) throw new Error('The viewer returned an invalid response. Update and restart the viewer.');
  return value;
}

const isConversationPage = (value: unknown) => isPage(value, isSummary);
const isMessagePage = (value: unknown) => isPage(value, isMessage);

function usePages<T>(url: string | null, valid: (value: unknown) => value is Page<T>, refresh: number) {
  const [state, setState] = useState<{ items: T[]; cursor: string | null; loading: boolean; error: string | null }>({
    items: [], cursor: null, loading: false, error: null,
  });
  const controller = useRef<AbortController | null>(null);
  async function load(cursor: string | null, append: boolean, request: AbortController) {
    if (!url) return;
    setState(previous => ({ ...previous, loading: true, error: null }));
    try {
      const page = await api(url + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''), valid, request.signal);
      if (!request.signal.aborted) {
        setState(previous => ({
          items: append ? [...previous.items, ...page.items] : page.items,
          cursor: page.nextCursor, loading: false, error: null,
        }));
      }
    } catch (error) {
      if (!request.signal.aborted) {
        setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : 'Could not read the local archive.' }));
      }
    }
  }
  useEffect(() => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setState({ items: [], cursor: null, loading: !!url, error: null });
    if (url) void load(null, false, request);
    return () => controller.current?.abort();
  }, [url, refresh, valid]);
  return {
    ...state,
    more() {
      if (state.loading || !state.cursor) return;
      const request = new AbortController();
      controller.current?.abort();
      controller.current = request;
      void load(state.cursor, true, request);
    },
  };
}

function date(value: number | string | null): string {
  if (value === null) return 'Not available';
  const parsed = new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : 'Invalid saved date';
}

function App() {
  const [refresh, setRefresh] = useState(0);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [status, setStatus] = useState<ArchiveStatus | null>(null);
  const [accountId, setAccountId] = useState('');
  const [groupId, setGroupId] = useState('all');
  const [groups, setGroups] = useState<ConversationGroup[]>([]);
  const [groupLoading, setGroupLoading] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [bootstrap, setBootstrap] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  const [detailState, setDetailState] = useState<{ detail: ConversationDetail; refresh: number } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const transcript = useRef<HTMLElement>(null);
  const detail = detailState?.refresh === refresh && detailState.detail.id === selected ? detailState.detail : null;
  const activeGroup = groups.find(group => group.id === groupId);
  const conversations = usePages(accountId ? `/api/conversations?accountId=${encodeURIComponent(accountId)}&group=${encodeURIComponent(groupId)}` : null, isConversationPage, refresh);
  const messages = usePages(detail ? `/api/conversations/${encodeURIComponent(detail.id)}/messages?accountId=${encodeURIComponent(accountId)}&revision=${encodeURIComponent(detail.revision)}` : null, isMessagePage, refresh);

  useEffect(() => {
    const request = new AbortController();
    setBootstrap({ loading: true, error: null });
    Promise.all([api('/api/status', isStatus, request.signal), api('/api/accounts', isAccounts, request.signal)])
      .then(([nextStatus, profiles]) => {
        if (request.signal.aborted) return;
        setStatus(nextStatus);
        setAccounts(profiles);
        setAccountId(previous => profiles.some(profile => profile.id === previous) ? previous : profiles[0]?.id ?? '');
        setBootstrap({ loading: false, error: null });
      }).catch(error => {
        if (!request.signal.aborted) setBootstrap({ loading: false, error: error instanceof Error ? error.message : 'Could not open archive.' });
      });
    return () => request.abort();
  }, [refresh]);

  useEffect(() => {
    const request = new AbortController();
    setGroups([]);
    setGroupError(null);
    setGroupLoading(!!accountId);
    if (accountId) {
      api(`/api/groups?accountId=${encodeURIComponent(accountId)}`, isGroups, request.signal)
        .then(value => {
          if (request.signal.aborted) return;
          setGroups(value);
          setGroupLoading(false);
          if (!value.some(group => group.id === groupId)) {
            setGroupId('all');
            setSelected(null);
          }
        }).catch(error => {
          if (!request.signal.aborted) {
            setGroupLoading(false);
            setGroupError(error instanceof Error ? error.message : 'Could not read conversation folders.');
          }
        });
    }
    return () => request.abort();
  }, [accountId, refresh]);

  useEffect(() => {
    const request = new AbortController();
    setDetailState(null);
    setDetailError(null);
    setDetailLoading(!!selected);
    if (selected && accountId) {
      api(`/api/conversations/${encodeURIComponent(selected)}?accountId=${encodeURIComponent(accountId)}`, isDetail, request.signal)
        .then(value => {
          if (request.signal.aborted) return;
          setDetailState({ detail: value, refresh });
          setDetailLoading(false);
          transcript.current?.scrollTo(0, 0);
        }).catch(error => {
          if (!request.signal.aborted) {
            setDetailLoading(false);
            setDetailError(error instanceof Error ? error.message : 'Could not read conversation.');
          }
        });
    }
    return () => request.abort();
  }, [accountId, selected, refresh]);

  function reload() { setRefresh(value => value + 1); }
  return <div className={`app ${selected ? 'has-selection' : ''}`}>
    <header className="app-header">
      <div className="brand"><span className="brand-icon" aria-hidden="true">L</span><div><h1>Local archive</h1><p>Your saved conversations, on your computer.</p></div></div>
      <div className="header-controls">
        <span className="local-badge"><span aria-hidden="true" />Local only / Read-only</span>
        <button onClick={reload} disabled={bootstrap.loading}>Refresh archive</button>
      </div>
    </header>
    {bootstrap.error && <div className="banner error" role="alert">{bootstrap.error} <button onClick={reload}>Retry</button></div>}
    <div className="workspace">
      <aside className="sidebar" aria-label="Saved conversations">
        <div className="sidebar-heading">
          <label htmlFor="account">Archive account</label>
          <select id="account" value={accountId} disabled={bootstrap.loading || !accounts.length} onChange={event => {
            setSelected(null); setDetailState(null); setGroupId('all'); setAccountId(event.target.value);
          }}>
            {!accounts.length && <option value="">No local accounts</option>}
            {accounts.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}
          </select>
        </div>
        <div className="chat-list">
          {groupLoading && <p className="state" role="status">Reading folders...</p>}
          {groupError && <p className="state error" role="alert">{groupError} <button onClick={reload}>Retry</button></p>}
          {groups.length > 0 && <nav className="folder-list" aria-label="Conversation folders">
            <p className="folder-heading">Folders</p>
            {groups.map(group => <button key={group.id} className="folder-item"
              aria-current={groupId === group.id ? 'true' : undefined} onClick={() => {
                if (groupId !== group.id) { setGroupId(group.id); setSelected(null); }
              }}>
              <span>{group.label}</span><span className="folder-count">{group.conversationCount}</span>
            </button>)}
            <p className="folder-note">Project and GPT names are unavailable. These are provisional folders from saved metadata.</p>
          </nav>}
          <div className="section-label"><h2>{activeGroup?.label ?? 'Conversations'}</h2><span>{activeGroup?.conversationCount ?? accounts.find(account => account.id === accountId)?.conversationCount ?? 0} saved</span></div>
          {bootstrap.loading && !status && <p className="state" role="status">Opening local archive...</p>}
          {!bootstrap.loading && !bootstrap.error && !accounts.length && <p className="state">No accounts have been synced. Sync a chat in the extension, then refresh.</p>}
          {conversations.error && <p className="state error" role="alert">{conversations.error} <button onClick={reload}>Retry</button></p>}
          {!bootstrap.error && !conversations.error && !conversations.loading && accountId && conversations.items.length === 0 &&
            <p className="state">No conversations saved in this folder.</p>}
          <nav aria-label="Conversation list">
            {conversations.items.map(chat => <button className="chat-item" aria-current={selected === chat.id ? 'true' : undefined}
              key={chat.id} onClick={() => setSelected(chat.id)}>
              <strong>{chat.title?.trim() || 'Untitled conversation'}</strong>
              <span>Updated {date(chat.updateTime)}</span>
              <span>{chat.messageCount} stored messages</span>
              <small>Synced {date(chat.lastSyncedAt)}</small>
            </button>)}
          </nav>
          {conversations.loading && <p className="state" role="status">Reading conversations...</p>}
          {conversations.cursor && <button className="load-more" onClick={conversations.more} disabled={conversations.loading}>Load more conversations</button>}
        </div>
        <footer>{status ? `${status.conversations} conversations / ${status.messages} stored messages` : 'Local SQLite archive'}<br />No ChatGPT connection required.</footer>
      </aside>
      <main className="reader" ref={transcript} tabIndex={-1}>
        {!selected ? <section className="welcome">
          <span className="welcome-icon" aria-hidden="true">[ ]</span><span className="eyebrow">YOUR OFFLINE LIBRARY</span>
          <h2>A place for your conversations.</h2>
          <p>Choose a saved chat to read its active branch. Your archive stays on this computer, and viewing never changes it.</p>
          <div className="welcome-notes"><span>Read without signing in</span><span>No remote requests</span><span>Archive preserved</span></div>
        </section> : <>
          <button className="back-button" onClick={() => setSelected(null)}>Back to conversations</button>
          {detailLoading && <p className="state" role="status">Opening saved conversation...</p>}
          {detailError && <div className="state error" role="alert">{detailError} <button onClick={reload}>Reload conversation</button></div>}
          {detail && <>
            <div className="conversation-heading">
              <span className="eyebrow">SAVED CONVERSATION / ACTIVE BRANCH</span>
              <h2>{detail.title?.trim() || 'Untitled conversation'}</h2>
              <p>Updated {date(detail.updateTime)} / Synced {date(detail.lastSyncedAt)}</p>
              <p>{detail.activeMessageCount} active messages / {detail.otherMessageCount} other stored messages</p>
              {detail.warnings.map(warning => <p className="banner warning" role="alert" key={warning}>{warning}</p>)}
            </div>
            <div className="messages" aria-label="Active branch messages">
              {messages.items.map(message => <article className={`message ${message.role === 'user' ? 'user' : 'other'}`} key={message.id}>
                <div className="message-meta"><strong>{message.role || 'unknown'}</strong><span>{message.model}{message.model ? ' / ' : ''}{date(message.createTime)}</span></div>
                {message.unsupportedContent && <p className="unsupported">Contains unsupported content or attachment references; only saved text/reference data is shown.</p>}
                <MessageContent text={message.text} contentType={message.contentType} />
              </article>)}
              {!messages.loading && !messages.error && !messages.items.length && <p className="state">No messages on a valid saved active branch.</p>}
              {messages.loading && <p className="state" role="status">Reading messages...</p>}
              {messages.error && <p className="banner error" role="alert">{messages.error} <button onClick={reload}>Reload conversation</button></p>}
              {messages.cursor && <button className="load-more" onClick={messages.more} disabled={messages.loading}>Load more messages</button>}
            </div>
          </>}
        </>}
      </main>
    </div>
  </div>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Viewer root element is missing.');
createRoot(root).render(token
  ? <App />
  : <main className="authorization"><span className="eyebrow">LOCAL ARCHIVE</span><h1>Open your private launch URL</h1><p>This tab has no access token. Reopen the full URL printed by the viewer command. Reloading a tab clears its in-memory authorization.</p></main>);
