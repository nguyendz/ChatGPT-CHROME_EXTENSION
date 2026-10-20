import { HOST_NAME, PROTOCOL_VERSION, isRecord, isResponsePayload } from './protocol.ts';
import type { ConnectionState, RequestPayloads, ResponsePayloads } from './protocol.ts';

export class HostConnectionError extends Error {
  state: ConnectionState;
  constructor(state: ConnectionState, message: string) {
    super(message);
    this.state = state;
  }
}

export function connectionError(message: string): HostConnectionError {
  const lower = message.toLowerCase();
  const state = lower.includes('not found') ? 'not-registered' :
    lower.includes('forbidden') ? 'forbidden' :
    lower.includes('exited') || lower.includes('communicating') ? 'host-exited' : 'unknown';
  return new HostConnectionError(state, message);
}

type Pending = {
  receive: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class HostClient {
  private port: chrome.runtime.Port | undefined;
  private pending = new Map<string, Pending>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private timeoutMs: number;
  private idleMs: number;
  private idleHolds = 0;

  constructor(timeoutMs = 10_000, idleMs = 30_000) {
    this.timeoutMs = timeoutMs;
    this.idleMs = idleMs;
  }

  private connect() {
    if (this.port) return this.port;
    const port = chrome.runtime.connectNative(HOST_NAME);
    this.port = port;
    port.onMessage.addListener((value: unknown) => {
      if (!isRecord(value) || typeof value.id !== 'string') {
        this.close(new HostConnectionError('host-exited', 'Invalid host response envelope'));
        return;
      }
      const pending = this.pending.get(value.id);
      if (!pending) {
        this.close(new HostConnectionError('host-exited', 'Host returned an unknown request ID'));
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(value.id);
      pending.receive(value);
      this.scheduleIdle();
    });
    port.onDisconnect.addListener(() => {
      const message = chrome.runtime.lastError?.message ?? 'Native host has exited.';
      if (this.port === port) {
        this.port = undefined;
        this.rejectPending(connectionError(message));
      }
    });
    return port;
  }

  private rejectPending(error: Error) {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private scheduleIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.pending.size && this.idleHolds === 0) this.idleTimer = setTimeout(() => this.close(), this.idleMs);
  }

  retain() {
    this.idleHolds++;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.idleHolds--;
      this.scheduleIdle();
    };
  }

  close(error = new HostConnectionError('host-exited', 'Native host connection closed')) {
    const port = this.port;
    this.port = undefined;
    this.rejectPending(error);
    port?.disconnect();
  }

  request<K extends keyof RequestPayloads>(type: K, payload: RequestPayloads[K]): Promise<ResponsePayloads[K]> {
    return new Promise((resolve, reject) => {
      try {
        const port = this.connect();
        if (this.idleTimer) clearTimeout(this.idleTimer);
        const id = crypto.randomUUID();
        const timer = setTimeout(() => this.close(
          new HostConnectionError('host-exited', `Local host timed out after ${this.timeoutMs} ms`),
        ), this.timeoutMs);
        this.pending.set(id, {
          timer, reject,
          receive(value) {
            if (!isRecord(value) || value.v !== PROTOCOL_VERSION) {
              reject(new HostConnectionError('protocol-mismatch', 'Host protocol version is incompatible'));
            } else if (value.type === 'error' && isRecord(value.payload) && typeof value.payload.message === 'string') {
              const state = value.payload.code === 'PROTOCOL_MISMATCH' ? 'protocol-mismatch' :
                value.payload.code === 'FORBIDDEN_ORIGIN' ? 'forbidden' : 'host-exited';
              reject(new HostConnectionError(state, value.payload.message));
            } else if (value.type !== `${type}.ok` || !isResponsePayload(type, value.payload)) {
              reject(new HostConnectionError('host-exited', 'Invalid host response payload'));
            } else {
              resolve(value.payload);
            }
          },
        });
        try {
          port.postMessage({ v: PROTOCOL_VERSION, id, type, payload });
        } catch (error) {
          this.close(connectionError(error instanceof Error ? error.message : String(error)));
        }
      } catch (error) {
        reject(connectionError(error instanceof Error ? error.message : String(error)));
      }
    });
  }
}
