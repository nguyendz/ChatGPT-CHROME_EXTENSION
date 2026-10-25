import { useEffect, useRef, useState } from 'react';
import { INLINE_IMAGE_TYPES, assetFileName } from '../markdown.ts';
import type { ViewerAsset } from '../types.ts';

export type AssetLoader = (fileId: string, signal: AbortSignal) => Promise<Blob>;

const STATE_NOTES: Record<ViewerAsset['state'], string> = {
  stored: 'saved', pending: 'not downloaded yet', 'too-large': 'over the 5 MB limit',
  unavailable: 'no longer available', failed: 'download failed',
};

function label(asset: ViewerAsset) {
  return asset.name ?? assetFileName(asset.fileId, asset.mime);
}

function size(bytes: number | null) {
  if (bytes === null) return '';
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Fetches the image through the authorized API and shows it from a blob URL once it scrolls into view. */
function StoredImage({ asset, load }: { asset: ViewerAsset; load: AssetLoader }) {
  const holder = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
  const [state, setState] = useState<{ url: string | null; error: boolean }>({ url: null, error: false });

  useEffect(() => {
    if (visible || !holder.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setVisible(true);
    });
    observer.observe(holder.current);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const request = new AbortController();
    let url: string | null = null;
    load(asset.fileId, request.signal).then(blob => {
      if (request.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setState({ url, error: false });
    }).catch(() => { if (!request.signal.aborted) setState({ url: null, error: true }); });
    return () => { request.abort(); if (url) URL.revokeObjectURL(url); };
  }, [visible, asset.fileId, load]);

  return <span className="asset-image" ref={holder}>
    {state.url ? <img src={state.url} alt={label(asset)} />
      : <span className="blocked-media">{state.error ? `[Image could not be read: ${label(asset)}]` : `[Loading image: ${label(asset)}]`}</span>}
  </span>;
}

function FileChip({ asset, load, save }: { asset: ViewerAsset; load: AssetLoader; save: (name: string, blob: Blob) => void }) {
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');
  async function download() {
    setState('busy');
    try {
      save(label(asset), await load(asset.fileId, new AbortController().signal));
      setState('idle');
    } catch {
      setState('error');
    }
  }
  return <span className="asset-file">
    <button type="button" onClick={() => void download()} disabled={state === 'busy'}>
      {state === 'busy' ? 'Saving...' : `Download ${label(asset)}`}{asset.size === null ? '' : ` (${size(asset.size)})`}
    </button>
    {state === 'error' && <span className="blocked-media" role="alert">Could not read this saved file.</span>}
  </span>;
}

export function MessageAssets({ assets, load, save }: {
  assets: ViewerAsset[]; load: AssetLoader; save: (name: string, blob: Blob) => void;
}) {
  if (!assets.length) return null;
  return <div className="message-assets" aria-label="Saved images and files">
    {assets.map(asset => asset.state !== 'stored'
      ? <p className="asset-missing" key={asset.fileId}>[File not downloaded: {label(asset)} ({STATE_NOTES[asset.state]})]</p>
      : asset.mime !== null && INLINE_IMAGE_TYPES.has(asset.mime)
        ? <StoredImage asset={asset} load={load} key={asset.fileId} />
        : <FileChip asset={asset} load={load} save={save} key={asset.fileId} />)}
  </div>;
}
