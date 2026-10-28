interface BrowserLocation { latitude: number; longitude: number; accuracy: number; timestamp: string }
interface DynamicContext { location?: BrowserLocation; locationError?: { code: number; message: string } }
interface ContextRequest { fields?: string[]; requestId?: string }
interface ContextOptions {
  geolocation?: Pick<Geolocation, "getCurrentPosition">;
  send?(response: { type: "dynamic_context_response"; requestId?: string; context: DynamicContext }): unknown;
}

import { formatBeijingDateTime } from "../../../shared/time-utils.js";

export function createDynamicContextProvider(options: ContextOptions = {}) {
  async function handle(event: ContextRequest) {
    const context: DynamicContext = {};
    if (event.fields?.includes("location")) {
      Object.assign(context, await getBrowserLocation());
    }
    options.send?.({
      type: "dynamic_context_response",
      requestId: event.requestId,
      context,
    });
  }

  function getBrowserLocation(): Promise<DynamicContext> {
    const geolocation = options.geolocation;
    if (!geolocation) return Promise.resolve({ locationError: { code: 0, message: "Geolocation API is unavailable" } });
    return new Promise<DynamicContext>(resolve => {
      try {
        geolocation.getCurrentPosition(
          position => resolve({ location: {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            timestamp: formatBeijingDateTime(position.timestamp),
          } }),
          error => resolve({ locationError: { code: error.code, message: error.message } }),
          { enableHighAccuracy: false, maximumAge: 300000, timeout: 5_000 },
        );
      } catch (error) {
        resolve({ locationError: {
          code: error instanceof DOMException && error.name === "SecurityError" ? 1 : 0,
          message: error instanceof Error ? error.message : String(error),
        } });
      }
    });
  }

  return { handle, getBrowserLocation };
}
