/** Local connection state. Credentials stay in the Background runtime. */
export interface CliConnectionStatus {
  state: "disconnected" | "connecting" | "connected" | "reconnecting" | "paused";
  clientId: string;
  name: string;
  endpoint: string;
  retryCount: number;
  retryLimit: number;
  connectedAt?: number;
  serviceVersion?: string;
  lastError?: { code: string; message: string };
}

export interface CliConnectionInput { endpoint?: string; name?: string }
