import { getClient } from '../polymarket/client';
import { log } from '../logger';
import type { MarketsWebSocket, PrivateWebSocket } from 'polymarket-us';

/**
 * WebSocket connection manager with heartbeat monitoring, automatic reconnect
 * with exponential backoff, and a polling-fallback signal. The worker uses the
 * connection status for health reporting and desync detection; the actual
 * trading decisions still run on a periodic cycle so the system remains correct
 * even if WebSockets are unavailable (polling fallback).
 */

const HEARTBEAT_TIMEOUT_MS = 45_000;
const MAX_BACKOFF_MS = 60_000;

type Status = {
  marketsConnected: boolean;
  privateConnected: boolean;
  lastMarketsHeartbeat: number;
  lastPrivateHeartbeat: number;
  desynced: boolean;
};

export class WsManager {
  private markets: MarketsWebSocket | null = null;
  private priv: PrivateWebSocket | null = null;
  private marketsBackoff = 1000;
  private privBackoff = 1000;
  private stopped = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private trackedSlugs: string[] = [];

  readonly status: Status = {
    marketsConnected: false,
    privateConnected: false,
    lastMarketsHeartbeat: 0,
    lastPrivateHeartbeat: 0,
    desynced: false,
  };

  /** Callback invoked when a fresh private update (order/position/balance) arrives. */
  onPrivateUpdate: (() => void) | null = null;

  async start(slugs: string[] = []): Promise<void> {
    this.stopped = false;
    this.trackedSlugs = slugs;
    await this.connectPrivate();
    await this.connectMarkets(slugs);
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), 10_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    try {
      this.markets?.close();
    } catch { /* ignore */ }
    try {
      this.priv?.close();
    } catch { /* ignore */ }
    this.status.marketsConnected = false;
    this.status.privateConnected = false;
  }

  updateTrackedMarkets(slugs: string[]): void {
    this.trackedSlugs = slugs;
    if (this.markets && this.status.marketsConnected && slugs.length > 0) {
      try {
        this.markets.subscribeMarketData('md-main', slugs);
      } catch (err) {
        log.warn('failed to update market subscriptions', { error: String(err) });
      }
    }
  }

  private async connectPrivate(): Promise<void> {
    if (this.stopped) return;
    try {
      const ws = getClient().ws.private();
      this.priv = ws;
      ws.on('heartbeat', () => {
        this.status.lastPrivateHeartbeat = Date.now();
      });
      ws.on('orderUpdate', () => this.onPrivateUpdate?.());
      ws.on('positionUpdate', () => this.onPrivateUpdate?.());
      ws.on('error', (err: unknown) => log.warn('private ws error', { error: String(err) }));
      ws.on('close', () => {
        this.status.privateConnected = false;
        this.scheduleReconnectPrivate();
      });
      await ws.connect();
      this.status.privateConnected = true;
      this.status.lastPrivateHeartbeat = Date.now();
      this.privBackoff = 1000;
      ws.subscribeOrders('orders-main');
      ws.subscribePositions('positions-main');
      ws.subscribeAccountBalance('balance-main');
      log.info('private websocket connected');
    } catch (err) {
      log.warn('private ws connect failed', { error: String(err) });
      this.status.privateConnected = false;
      this.scheduleReconnectPrivate();
    }
  }

  private async connectMarkets(slugs: string[]): Promise<void> {
    if (this.stopped) return;
    try {
      const ws = getClient().ws.markets();
      this.markets = ws;
      ws.on('heartbeat', () => {
        this.status.lastMarketsHeartbeat = Date.now();
      });
      ws.on('error', (err: unknown) => log.warn('markets ws error', { error: String(err) }));
      ws.on('close', () => {
        this.status.marketsConnected = false;
        this.scheduleReconnectMarkets();
      });
      await ws.connect();
      this.status.marketsConnected = true;
      this.status.lastMarketsHeartbeat = Date.now();
      this.marketsBackoff = 1000;
      if (slugs.length > 0) ws.subscribeMarketData('md-main', slugs);
      log.info('markets websocket connected', { markets: slugs.length });
    } catch (err) {
      log.warn('markets ws connect failed', { error: String(err) });
      this.status.marketsConnected = false;
      this.scheduleReconnectMarkets();
    }
  }

  private scheduleReconnectPrivate(): void {
    if (this.stopped) return;
    const delay = this.privBackoff;
    this.privBackoff = Math.min(MAX_BACKOFF_MS, this.privBackoff * 2);
    log.info('scheduling private ws reconnect', { delayMs: delay });
    setTimeout(() => this.connectPrivate(), delay);
  }

  private scheduleReconnectMarkets(): void {
    if (this.stopped) return;
    const delay = this.marketsBackoff;
    this.marketsBackoff = Math.min(MAX_BACKOFF_MS, this.marketsBackoff * 2);
    log.info('scheduling markets ws reconnect', { delayMs: delay });
    setTimeout(() => this.connectMarkets(this.trackedSlugs), delay);
  }

  /**
   * Detect heartbeat starvation. If a connection claims to be up but has not
   * produced a heartbeat within the timeout, treat it as desynced and force a
   * reconnect. The worker falls back to polling while disconnected.
   */
  private checkHeartbeats(): void {
    const now = Date.now();
    if (
      this.status.privateConnected &&
      this.status.lastPrivateHeartbeat > 0 &&
      now - this.status.lastPrivateHeartbeat > HEARTBEAT_TIMEOUT_MS
    ) {
      log.warn('private ws heartbeat timeout — forcing reconnect');
      this.status.privateConnected = false;
      try {
        this.priv?.close();
      } catch { /* ignore */ }
      this.scheduleReconnectPrivate();
    }
    if (
      this.status.marketsConnected &&
      this.status.lastMarketsHeartbeat > 0 &&
      now - this.status.lastMarketsHeartbeat > HEARTBEAT_TIMEOUT_MS
    ) {
      log.warn('markets ws heartbeat timeout — forcing reconnect');
      this.status.marketsConnected = false;
      try {
        this.markets?.close();
      } catch { /* ignore */ }
      this.scheduleReconnectMarkets();
    }
    // Desync flag: both down means we are running purely on polling.
    this.status.desynced = !this.status.privateConnected && !this.status.marketsConnected;
  }
}
