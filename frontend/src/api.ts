/**
 * Frontend transport layer for REST requests and live WebSocket ticks.
 *
 * Main UI code uses this client to fetch snapshots, mutate runtime state, and
 * subscribe to server-pushed updates with automatic reconnect behavior.
 */

const API_BASE = import.meta.env.VITE_API_URL || "";

export class ApiClient {
  private ws: WebSocket | null = null;
  private wsListeners: Set<(data: any) => void> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 10000;

  /**
   * Execute a JSON REST request against backend API base URL.
   * Used by: frontend/src/main.ts for state fetches, runtime control updates,
   * reset actions, and event injection.
   */
  async request<T = any>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Request failed: ${response.status}`);
    }
    return data;
  }

  /**
   * Open realtime websocket stream with reconnect handling.
   * Used by: frontend/src/main.ts after initial bootstrap to receive tick
   * snapshots from backend /ws/state.
   */
  connectWebSocket() {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const host = API_BASE ? API_BASE.replace(/^https?:\/\//, "") : location.host;
    const url = `${protocol}//${host}/ws/state`;

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "ping") return;
          for (const listener of this.wsListeners) {
            listener(data);
          }
        } catch {}
      };

      this.ws.onclose = () => {
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule exponential-backoff websocket reconnect attempt.
   * Used by: connectWebSocket close/error paths to keep realtime feed alive.
   */
  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, delay);
  }

  /**
   * Register a listener for parsed websocket messages.
   * Used by: frontend/src/main.ts to apply incoming `tick` payload updates.
   */
  onMessage(listener: (data: any) => void) {
    this.wsListeners.add(listener);
    return () => this.wsListeners.delete(listener);
  }

  /**
   * Close websocket and cancel pending reconnect timers.
   * Used by: lifecycle/cleanup flows where realtime stream should stop.
   */
  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}

export const api = new ApiClient();
