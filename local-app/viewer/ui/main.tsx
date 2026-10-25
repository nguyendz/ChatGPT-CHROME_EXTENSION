import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { isAccounts, isDetail, isGroups, isMarkdownExport, isMessage, isPage, isStatus, isSummary } from '../types.ts';
import type { Account, ArchiveStatus, ConversationDetail, ConversationGroup, ExportAsset, Page } from '../types.ts';
import { safeFileName } from '../markdown.ts';
import { createZip } from '../zip.ts';
import type { ZipEntry } from '../zip.ts';
import { MessageAssets } from './message-assets.tsx';
import { MessageContent } from './message-content.tsx';
import './style.css';

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  }
}

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

function saveFile(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function uniqueName(name: string, used: Set<string>): string {
  const base = name.replace(/\.md$/i, '');
  let candidate = name;
  for (let index = 2; used.has(candidate.toLowerCase()); index++) candidate = `${base} ${index}.md`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function markdownUrl(accountId: string, id: string, userOnly: boolean): string {
  return `/api/conversations/${encodeURIComponent(id)}/markdown?accountId=${encodeURIComponent(accountId)}${userOnly ? '&roles=user' : ''}`;
}

function assetUrl(accountId: string, conversationId: string, fileId: string): string {
  return `/api/assets/${encodeURIComponent(fileId)}?accountId=${encodeURIComponent(accountId)}&conversationId=${encodeURIComponent(conversationId)}`;
}

async function fetchBlob(url: string, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`Local archive request failed (${response.status}).`);
  return response.blob();
}

/** Reads every stored file an export links to; a missing file fails the export instead of leaving a broken link. */
async function readExportAssets(
  accountId: string, conversationId: string, assets: ExportAsset[], signal: AbortSignal, skip: Set<string> = new Set(),
): Promise<Array<{ fileName: string; blob: Blob }>> {
  const files: Array<{ fileName: string; blob: Blob }> = [];
  for (const asset of assets) {
    if (skip.has(asset.fileName)) continue;
    try {
      files.push({ fileName: asset.fileName, blob: await fetchBlob(assetUrl(accountId, conversationId, asset.fileId), signal) });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error('A saved image or file could not be read from the local archive folder.');
    }
  }
  return files;
}

type FolderExport = { busy: boolean; done: number; total: number; message: string | null; error: boolean };

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
  const [singleExport, setSingleExport] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [folderExport, setFolderExport] = useState<FolderExport | null>(null);
  const [userOnly, setUserOnly] = useState(false);
  const folderController = useRef<AbortController | null>(null);
  const transcript = useRef<HTMLElement>(null);
  const detail = detailState?.refresh === refresh && detailState.detail.id === selected ? detailState.detail : null;
  const conversations = usePages(accountId ? `/api/conversations?accountId=${encodeURIComponent(accountId)}&group=${encodeURIComponent(groupId)}` : null, isConversationPage, refresh);
  const messages = usePages(detail ? `/api/conversations/${encodeURIComponent(detail.id)}/messages?accountId=${encodeURIComponent(accountId)}&revision=${encodeURIComponent(detail.revision)}` : null, isMessagePage, refresh);
  const detailId = detail?.id;
  const loadAsset = useCallback((fileId: string, signal: AbortSignal) =>
    fetchBlob(assetUrl(accountId, detailId ?? '', fileId), signal), [accountId, detailId]);

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
    setFolderExport(previous => previous?.busy ? previous : null);
  }, [accountId, groupId]);

  useEffect(() => {
    const request = new AbortController();
    setDetailState(null);
    setDetailError(null);
    setSingleExport(previous => ({ ...previous, error: null }));
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

  async function exportConversation(id: string) {
    const request = new AbortController();
    setSingleExport({ busy: true, error: null });
    try {
      const result = await api(markdownUrl(accountId, id, userOnly), isMarkdownExport, request.signal);
      if (result.assets.length) {
        const files = await readExportAssets(accountId, id, result.assets, request.signal);
        const entries: ZipEntry[] = [{ name: result.fileName, data: new TextEncoder().encode(result.markdown) }];
        for (const file of files) entries.push({ name: `assets/${file.fileName}`, data: new Uint8Array(await file.blob.arrayBuffer()) });
        saveFile(result.fileName.replace(/\.md$/i, '.zip'), createZip(entries), 'application/zip');
      } else {
        saveFile(result.fileName, result.markdown, 'text/markdown;charset=utf-8');
      }
      setSingleExport({ busy: false, error: null });
    } catch (error) {
      setSingleExport({ busy: false, error: error instanceof Error ? error.message : 'Could not export this conversation.' });
    }
  }

  async function exportFolder() {
    const group = groups.find(item => item.id === groupId);
    if (!group || !accountId || folderExport?.busy) return;
    const account = accountId;
    const onlyUser = userOnly;
    const folderName = safeFileName(`${group.label}${onlyUser ? ' - user messages' : ''}`, 'Conversations');
    let directory: FileSystemDirectoryHandle | null = null;
    if (window.showDirectoryPicker) {
      try {
        const root = await window.showDirectoryPicker({ id: 'markdown-export', mode: 'readwrite' });
        directory = await root.getDirectoryHandle(folderName, { create: true });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setFolderExport({ busy: false, done: 0, total: 0, error: true,
          message: error instanceof Error ? `Could not open the export folder: ${error.message}` : 'Could not open the export folder.' });
        return;
      }
    }
    const request = new AbortController();
    folderController.current = request;
    const progress = (done: number, total: number) =>
      setFolderExport({ busy: true, done, total, message: null, error: false });
    progress(0, group.conversationCount);
    try {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Page<{ id: string }> = await api(`/api/conversations?accountId=${encodeURIComponent(account)}&group=${encodeURIComponent(group.id)}&limit=100` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''), isConversationPage, request.signal);
        ids.push(...page.items.map(item => item.id));
        cursor = page.nextCursor;
      } while (cursor);
      progress(0, ids.length);
      const used = new Set<string>();
      const entries: ZipEntry[] = [];
      const encoder = new TextEncoder();
      const writtenAssets = new Set<string>();
      let assetsDirectory: FileSystemDirectoryHandle | null = null;
      let failed = 0;
      for (const [index, id] of ids.entries()) {
        let result;
        let files: Array<{ fileName: string; blob: Blob }> = [];
        try {
          result = await api(markdownUrl(account, id, onlyUser), isMarkdownExport, request.signal);
          files = await readExportAssets(account, id, result.assets, request.signal, writtenAssets);
        } catch (error) {
          if (request.signal.aborted) throw error;
          result = undefined;
          failed++;
        }
        if (result) {
          const name = uniqueName(result.fileName, used);
          if (directory) {
            if (files.length) assetsDirectory ??= await directory.getDirectoryHandle('assets', { create: true });
            for (const file of files) {
              const writable = await (await assetsDirectory!.getFileHandle(file.fileName, { create: true })).createWritable();
              await writable.write(file.blob);
              await writable.close();
            }
            const writable = await (await directory.getFileHandle(name, { create: true })).createWritable();
            await writable.write(result.markdown);
            await writable.close();
          } else {
            for (const file of files) {
              entries.push({ name: `${folderName}/assets/${file.fileName}`, data: new Uint8Array(await file.blob.arrayBuffer()) });
            }
            entries.push({ name: `${folderName}/${name}`, data: encoder.encode(result.markdown) });
          }
          for (const file of files) writtenAssets.add(file.fileName);
        }
        progress(index + 1, ids.length);
      }
      if (!directory && entries.length) saveFile(`${folderName}.zip`, createZip(entries), 'application/zip');
      const exported = ids.length - failed;
      setFolderExport({ busy: false, done: ids.length, total: ids.length, error: failed > 0,
        message: `Exported ${exported} of ${ids.length} conversation${ids.length === 1 ? '' : 's'} to ` +
          (directory ? `the "${folderName}" folder.` : `${folderName}.zip.`) +
          (failed ? ` ${failed} could not be read; retry after the archive settles.` : '') });
    } catch (error) {
      setFolderExport(previous => ({ busy: false, done: previous?.done ?? 0, total: previous?.total ?? 0, error: true,
        message: request.signal.aborted
          ? `Export cancelled.${directory ? ' Files already written were kept.' : ''}`
          : error instanceof Error ? `Export stopped: ${error.message}` : 'Export stopped.' }));
    } finally {
      if (folderController.current === request) folderController.current = null;
    }
  }

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
          {groups.length > 0 && <div className="folder-picker">
            <label htmlFor="folder-select">Folder</label>
            <select id="folder-select" value={groupId} onChange={event => {
              const nextGroup = event.currentTarget.value;
              if (groups.some(group => group.id === nextGroup) && groupId !== nextGroup) {
                setGroupId(nextGroup);
                setSelected(null);
              }
            }}>
              {groups.map(group => <option key={group.id} value={group.id}>
                {group.label} ({group.conversationCount})
              </option>)}
            </select>
            <div className="export-row">
              <label className="export-option">
                <input type="checkbox" checked={userOnly} disabled={folderExport?.busy || singleExport.busy}
                  onChange={event => setUserOnly(event.currentTarget.checked)} />
                User messages only
              </label>
            </div>
            <div className="export-row">
              {folderExport?.busy
                ? <>
                  <span role="status">Exporting {folderExport.done} / {folderExport.total}...</span>
                  <button type="button" onClick={() => folderController.current?.abort()}>Cancel export</button>
                </>
                : <button type="button" className="export-folder" onClick={() => void exportFolder()}
                  disabled={!groups.find(group => group.id === groupId)?.conversationCount}
                  title="Save one Markdown file per conversation in this folder">Export folder to Markdown</button>}
            </div>
            {folderExport?.message && <p className={`export-message ${folderExport.error ? 'error' : ''}`} role="status">
              {folderExport.message}
            </p>}
          </div>}
          {bootstrap.loading && !status && <p className="state" role="status">Opening local archive...</p>}
          {!bootstrap.loading && !bootstrap.error && !accounts.length && <p className="state">No accounts have been synced. Sync a chat in the extension, then refresh.</p>}
          {conversations.error && <p className="state error" role="alert">{conversations.error} <button onClick={reload}>Retry</button></p>}
          {!bootstrap.error && !conversations.error && !conversations.loading && accountId && conversations.items.length === 0 &&
            <p className="state">No conversations saved in this folder.</p>}
          <nav aria-label="Conversation list">
            {conversations.items.map(chat => <button className="chat-item" aria-current={selected === chat.id ? 'true' : undefined}
              key={chat.id} onClick={() => setSelected(chat.id)}>
              <strong>{chat.title?.trim() || 'Untitled conversation'} <span className="message-count">({chat.messageCount})</span></strong>
            </button>)}
          </nav>
          {conversations.loading && <p className="state" role="status">Reading conversations...</p>}
          {conversations.cursor && <button className="load-more" onClick={conversations.more} disabled={conversations.loading}>Load more conversations</button>}
        </div>
        <footer>
          <div className="sidebar-footer-summary">
            <span>{status ? `${status.conversations} conversations` : 'Local SQLite archive'}</span>
            <span>Last sync {status?.lastSyncAt ? date(status.lastSyncAt) : status ? 'Never' : 'Unavailable'}</span>
          </div>
        </footer>
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
              <div className="export-row">
                <button type="button" className="export-conversation" disabled={singleExport.busy}
                  onClick={() => void exportConversation(detail.id)}>
                  {singleExport.busy ? 'Exporting...' : userOnly ? 'Export Markdown (user messages only)' : 'Export Markdown'}
                </button>
              </div>
              {singleExport.error && <p className="banner error" role="alert">{singleExport.error}</p>}
              {detail.warnings.map(warning => <p className="banner warning" role="alert" key={warning}>{warning}</p>)}
            </div>
            <div className="messages" aria-label="Active branch messages">
              {messages.items.map(message => <article className={`message ${message.role === 'user' ? 'user' : 'other'}`} key={message.id}>
                <div className="message-meta"><strong>{message.role || 'unknown'}</strong><span>{message.model}{message.model ? ' / ' : ''}{date(message.createTime)}</span></div>
                {message.unsupportedContent && !(message.assets.length && message.assets.every(asset => asset.state === 'stored')) &&
                  <p className="unsupported">Contains unsupported content or attachment references; only saved text/reference data is shown.</p>}
                <MessageContent text={message.text} contentType={message.contentType} />
                <MessageAssets assets={message.assets} load={loadAsset}
                  save={(name, blob) => saveFile(safeFileName(name, 'file'), blob, blob.type || 'application/octet-stream')} />
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
