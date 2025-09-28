import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { DeribitTickerData } from '../models/deribit';

interface JsonRpcSuccess<T> {
  jsonrpc: '2.0';
  id: number;
  result: T;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id?: number;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcError;

interface JsonRpcSubscription<T> {
  jsonrpc: '2.0';
  method: 'subscription';
  params: {
    channel: string;
    data: T;
  };
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

const WS_URL = 'wss://www.deribit.com/ws/api/v2';
const HEARTBEAT_INTERVAL_MS = 25_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 16_000;

@Injectable({ providedIn: 'root' })
export class DeribitWebsocketService implements OnDestroy {
  private socket: WebSocket | null = null;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly channelHandlers = new Map<string, Set<(data: DeribitTickerData) => void>>();
  private readonly pendingMessages: string[] = [];
  private nextId = 1;
  private heartbeatTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelay = RECONNECT_BASE_DELAY_MS;
  private shouldResubscribe = false;
  private intentionalClose = false;

  constructor(private readonly zone: NgZone) {}

  ngOnDestroy(): void {
    this.disposeSocket();
  }

  subscribeTicker(instrumentName: string, handler: (data: DeribitTickerData) => void): () => void {
    const channel = `ticker.${instrumentName}.raw`;
    let handlers = this.channelHandlers.get(channel);
    const isFirst = !handlers;
    if (!handlers) {
      handlers = new Set();
      this.channelHandlers.set(channel, handlers);
    }
    handlers.add(handler);

    this.ensureSocket();

    if (isFirst) {
      void this.send('public/subscribe', { channels: [channel] }).catch(() => {
        this.channelHandlers.delete(channel);
      });
    }

    return () => {
      const currentHandlers = this.channelHandlers.get(channel);
      if (!currentHandlers) {
        return;
      }
      currentHandlers.delete(handler);
      if (currentHandlers.size === 0) {
        this.channelHandlers.delete(channel);
        void this.send('public/unsubscribe', { channels: [channel] }).catch(() => {
          /* noop: connection may already be closed */
        });
        if (this.channelHandlers.size === 0) {
          this.disposeSocket();
        }
      }
    };
  }

  private ensureSocket(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.zone.runOutsideAngular(() => {
      this.intentionalClose = false;
      this.socket = new WebSocket(WS_URL);
      this.socket.addEventListener('open', this.handleOpen);
      this.socket.addEventListener('message', this.handleMessage);
      this.socket.addEventListener('close', this.handleClose);
      this.socket.addEventListener('error', this.handleError);
    });
  }

  private handleOpen = (): void => {
    this.reconnectDelay = RECONNECT_BASE_DELAY_MS;
    this.flushPendingMessages();
    this.startHeartbeat();
    if (this.shouldResubscribe && this.channelHandlers.size > 0) {
      const channels = Array.from(this.channelHandlers.keys());
      void this.send('public/subscribe', { channels }).catch(() => {
        /* re-subscribe failures will retry on next reconnect */
      });
    }
    this.shouldResubscribe = false;
  };

  private handleMessage = (event: MessageEvent<string>): void => {
    try {
      const payload = JSON.parse(event.data) as JsonRpcResponse<unknown> | JsonRpcSubscription<DeribitTickerData>;
      if (this.isSubscription(payload)) {
        this.dispatchSubscription(payload.params.channel, payload.params.data);
        return;
      }

      if ('id' in payload && payload.id !== undefined) {
        const pending = this.pendingRequests.get(payload.id);
        if (!pending) {
          return;
        }
        this.pendingRequests.delete(payload.id);
        if ('error' in payload) {
          pending.reject(payload.error);
        } else {
          pending.resolve(payload.result);
        }
      }
    } catch {
      /* ignore malformed payloads */
    }
  };

  private handleClose = (): void => {
    this.stopHeartbeat();
    this.socket?.removeEventListener('open', this.handleOpen);
    this.socket?.removeEventListener('message', this.handleMessage);
    this.socket?.removeEventListener('close', this.handleClose);
    this.socket?.removeEventListener('error', this.handleError);
    this.socket = null;

    if (this.intentionalClose) {
      this.intentionalClose = false;
      this.rejectAllPending(new Error('Deribit WebSocket connection closed'));
      this.pendingMessages.length = 0;
      return;
    }

    this.rejectAllPending(new Error('Deribit WebSocket connection lost'));
    this.shouldResubscribe = true;
    if (this.channelHandlers.size > 0) {
      this.scheduleReconnect();
    }
  };

  private handleError = (): void => {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close();
    }
  };

  private dispatchSubscription(channel: string, data: DeribitTickerData): void {
    const handlers = this.channelHandlers.get(channel);
    if (!handlers || handlers.size === 0) {
      return;
    }

    this.zone.run(() => {
      handlers.forEach((handler) => handler(data));
    });
  }

  private send(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.ensureSocket();
    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(message);
      } else {
        this.pendingMessages.push(message);
      }
      // Safety timeout to avoid hanging promises
      window.setTimeout(() => {
        if (!this.pendingRequests.has(id)) {
          return;
        }
        this.pendingRequests.delete(id);
        reject(new Error(`${method} request timed out`));
      }, 10_000);
    });
  }

  private flushPendingMessages(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    while (this.pendingMessages.length > 0) {
      const message = this.pendingMessages.shift();
      if (!message) {
        continue;
      }
      this.socket.send(message);
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      return;
    }
    this.zone.runOutsideAngular(() => {
      this.heartbeatTimer = window.setInterval(() => {
        void this.send('public/ping', {}).catch(() => {
          /* ping failures will be handled by connection close */
        });
      }, HEARTBEAT_INTERVAL_MS);
    });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === null) {
      return;
    }
    window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      return;
    }
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(RECONNECT_MAX_DELAY_MS, this.reconnectDelay * 2);
    this.zone.runOutsideAngular(() => {
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        this.ensureSocket();
      }, delay);
    });
  }

  private disposeSocket(): void {
    if (!this.socket) {
      return;
    }
    this.intentionalClose = true;
    this.stopHeartbeat();
    this.socket.removeEventListener('open', this.handleOpen);
    this.socket.removeEventListener('message', this.handleMessage);
    this.socket.removeEventListener('close', this.handleClose);
    this.socket.removeEventListener('error', this.handleError);
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
    this.socket = null;
    this.pendingMessages.length = 0;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending(new Error('Deribit WebSocket connection disposed'));
    this.shouldResubscribe = false;
    this.intentionalClose = false;
  }

  private rejectAllPending(reason: Error): void {
    this.pendingRequests.forEach((pending) => pending.reject(reason));
    this.pendingRequests.clear();
  }

  private isSubscription(
    payload: JsonRpcResponse<unknown> | JsonRpcSubscription<DeribitTickerData>
  ): payload is JsonRpcSubscription<DeribitTickerData> {
    return (payload as JsonRpcSubscription<DeribitTickerData>).method === 'subscription';
  }
}
