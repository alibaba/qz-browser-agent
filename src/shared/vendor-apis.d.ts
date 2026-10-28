/** Upstream declarations omit these distributed subpaths; the public API remains authoritative. */
declare module 'pdfjs-dist/build/pdf.mjs' {
  export * from 'pdfjs-dist';
}
declare module 'pdfjs-dist/build/pdf.worker.mjs' {
  export { WorkerMessageHandler } from 'pdfjs-dist/types/src/core/worker.js';
}
declare module "turndown-plugin-gfm" {
  export const gfm: import("turndown").Plugin;
}

/** The build wraps the locked SDK in a cached factory for MV3 startup. */
declare module "#mcp-sdk" {
  export function getMcpSdk(): {
    Client: typeof import("@modelcontextprotocol/sdk/client/index.js").Client;
    StreamableHTTPClientTransport: typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js").StreamableHTTPClientTransport;
    CfWorkerJsonSchemaValidator: typeof import("@modelcontextprotocol/sdk/validation/cfworker").CfWorkerJsonSchemaValidator;
  };
}
