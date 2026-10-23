import { ECHO_BYTES, PROTOCOL_VERSION } from './protocol.ts';
import { HostClient, HostConnectionError } from './host-client.ts';
import type { ApiProbeReport, ConnectionStatus, EchoResult } from './protocol.ts';

const client = new HostClient();

export async function getHostStatus(): Promise<ConnectionStatus> {
  try {
    const host = await client.request('hello', {
      protocolVersion: PROTOCOL_VERSION, extVersion: chrome.runtime.getManifest().version,
    });
    const start = performance.now();
    await client.request('ping', {});
    return { state: 'connected', host, rttMs: Math.round(performance.now() - start) };
  } catch (error) {
    return {
      state: error instanceof HostConnectionError ? error.state : 'unknown',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function echoHost(): Promise<EchoResult> {
  const data = 'x'.repeat(ECHO_BYTES);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  const sha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  const response = await client.request('echo', { data });
  if (response.sha256 !== sha256 || response.bytes !== ECHO_BYTES) throw new Error('Echo size or SHA-256 mismatch');
  return { ...response, matches: true };
}

export function recordApiProbe(report: ApiProbeReport): Promise<{ probeId: string; logged: true }> {
  return client.request('recordApiProbe', report);
}

export function launchLocalViewer(): Promise<{ url: string }> {
  return client.request('launchViewer', {});
}

export function retainViewerHost(): () => void {
  return client.retain();
}
