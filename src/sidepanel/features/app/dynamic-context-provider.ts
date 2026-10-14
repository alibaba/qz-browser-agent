interface BrowserLocation { latitude: number; longitude: number; accuracy: number; timestamp: string }
interface DynamicContext { location?: BrowserLocation }
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
      const location = await getBrowserLocation();
      if (location) context.location = location;
    }
    options.send?.({
      type: "dynamic_context_response",
      requestId: event.requestId,
      context,
    });
  }

  function getBrowserLocation(): Promise<BrowserLocation | null> {
    const geolocation = options.geolocation;
    if (!geolocation) return Promise.resolve(null);
    return new Promise<BrowserLocation | null>(resolve => {
      geolocation.getCurrentPosition(
        position => resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          timestamp: formatBeijingDateTime(position.timestamp),
        }),
        () => resolve(null),
        {
          enableHighAccuracy: false,
          maximumAge: 300000,
          timeout: 10_000,
        },
      );
    });
  }

  return { handle, getBrowserLocation };
}
