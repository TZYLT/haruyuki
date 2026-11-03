/**
 * Shared types and socket plumbing for {@link AppServerClient}.
 *
 * Split out of `app-server-client.ts` so the entry module keeps room for the
 * per-command helper methods (the package's `./app-server-client` subpath stays
 * the only public surface; this module is re-exported whole).
 */
import type {
  ExternalToolCallRequestMessage,
  ExternalToolCallResult,
  WsProtocolCommand,
  WsProtocolMessage,
} from "./types/app-server-protocol";

export type AppServerChannel = "control" | "stream";

export type AppServerRawCommand = Record<string, unknown> & {
  type: string;
  request_id?: string;
};

export type AppServerRawResponse = Record<string, unknown> & {
  type: string;
  request_id?: string;
};

export type AppServerSendCommand = WsProtocolCommand | AppServerRawCommand;

/** Receives every parsed protocol frame from the app-server WebSocket. */
export type AppServerMessageHandler = (
  message: WsProtocolMessage,
  channel: AppServerChannel,
) => void;

/** Called synchronously before a typed or raw command is written to the socket. */
export type AppServerSendHandler = (command: AppServerSendCommand) => void;

export interface AppServerDisconnectEvent {
  channel: AppServerChannel;
  event: unknown;
}

/** Called once when the WebSocket closes before client.close(). */
export type AppServerDisconnectHandler = (
  disconnect: AppServerDisconnectEvent,
) => void;

export type AppServerExternalToolCallHandler = (
  request: ExternalToolCallRequestMessage,
) => Promise<ExternalToolCallResult> | ExternalToolCallResult;

export interface AppServerSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
  on?(type: string, listener: (event: unknown) => void): void;
  off?(type: string, listener: (event: unknown) => void): void;
  once?(type: string, listener: (event: unknown) => void): void;
}

export interface AppServerSocketOptions {
  headers?: Record<string, string>;
}

export type AppServerSocketConstructor = new (
  url: string,
  options?: AppServerSocketOptions,
) => AppServerSocketLike;

export interface AppServerClientOptions {
  /** Base app-server URL, e.g. ws://127.0.0.1:4500 or http://127.0.0.1:4500. */
  url: string;
  /** Optional capability token sent as Authorization: Bearer <token>; requires a WebSocket implementation with header support. */
  authToken?: string;
  /** Optional WebSocket constructor for Node/tests. Browsers use globalThis.WebSocket. */
  WebSocket?: AppServerSocketConstructor;
  /** Default timeout for request_id-correlated control requests. */
  requestTimeoutMs?: number;
}

export interface AppServerRequestOptions<TMessage extends WsProtocolMessage> {
  timeoutMs?: number;
  predicate?: (message: WsProtocolMessage) => message is TMessage;
}

export type AppServerRequestCommand = Extract<
  WsProtocolCommand,
  { request_id?: string }
>;

/**
 * Distributive form of a protocol command with an optional request id.
 *
 * `Omit<Union, "request_id">` is not distributive (it keeps only keys common to
 * every member), so the additive command families spell this type once and the
 * per-domain wrappers stay terse.
 */
export type AppServerCommandBody = {
  [TType in WsProtocolCommand["type"]]: Omit<
    Extract<WsProtocolCommand, { type: TType }>,
    "request_id"
  > & { request_id?: string };
}[WsProtocolCommand["type"]];

/**
 * Command body accepted by the additive family wrappers: the wrapper adds the
 * discriminant and derives the request id, so callers pass only the payload.
 */
export type AppServerFamilyCommandBody<T extends { type: string }> = Omit<
  T,
  "type" | "request_id"
> & {
  request_id?: string;
};

/** Family-wrapper options; `requestCommand` derives the response predicate. */
export type AppServerFamilyCommandOptions<T extends WsProtocolMessage> = Omit<
  AppServerRequestOptions<T>,
  "predicate"
>;

export type AppServerRequestCommandWithId = AppServerRequestCommand & {
  request_id: string;
};

export type AppServerRequestBody = Record<string, unknown> & {
  request_id?: string;
};

export interface AppServerRawRequestOptions<
  TResponse extends AppServerRawResponse,
> {
  timeoutMs?: number;
  predicate: (message: unknown) => message is TResponse;
}

export type PendingRequest = {
  resolve: (message: WsProtocolMessage) => void;
  reject: (error: Error) => void;
  predicate?: (message: WsProtocolMessage) => boolean;
  timeout: ReturnType<typeof setTimeout>;
};

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const WEBSOCKET_OPEN_STATE = 1;

export function getGlobalWebSocket(): AppServerSocketConstructor | undefined {
  return (globalThis as { WebSocket?: AppServerSocketConstructor }).WebSocket;
}

function normalizeBaseUrl(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`Unsupported app-server URL protocol: ${parsed.protocol}`);
  }
  if (!parsed.pathname || parsed.pathname === "/") {
    parsed.pathname = "/ws";
  }
  return parsed;
}

export function resolveAppServerUrl(url: string): string {
  const parsed = normalizeBaseUrl(url);
  parsed.searchParams.delete("channel");
  return parsed.toString();
}

/**
 * @deprecated App-server uses one bidirectional WebSocket. Both historical
 * channel names resolve to that same socket URL.
 */
export function resolveAppServerChannelUrl(
  url: string,
  _channel: AppServerChannel,
): string {
  return resolveAppServerUrl(url);
}

export function attachSocketListener(
  socket: AppServerSocketLike,
  type: string,
  listener: (event: unknown) => void,
): () => void {
  if (socket.addEventListener && socket.removeEventListener) {
    socket.addEventListener(type, listener);
    return () => socket.removeEventListener?.(type, listener);
  }

  if (socket.on) {
    socket.on(type, listener);
    return () => socket.off?.(type, listener);
  }

  throw new Error("WebSocket implementation does not support event listeners");
}

function onceSocketEvent(
  socket: AppServerSocketLike,
  type: string,
  listener: (event: unknown) => void,
): () => void {
  if (socket.once) {
    socket.once(type, listener);
    return () => socket.off?.(type, listener);
  }

  let detach = () => {};
  detach = attachSocketListener(socket, type, (event) => {
    detach();
    listener(event);
  });
  return detach;
}

export function waitForSocketOpen(socket: AppServerSocketLike): Promise<void> {
  if (socket.readyState === WEBSOCKET_OPEN_STATE) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let detachOpen = () => {};
    let detachError = () => {};
    const cleanup = () => {
      detachOpen();
      detachError();
    };
    detachOpen = onceSocketEvent(socket, "open", () => {
      cleanup();
      resolve();
    });
    detachError = onceSocketEvent(socket, "error", (event) => {
      cleanup();
      reject(
        new Error(`App-server WebSocket failed to open: ${String(event)}`),
      );
    });
  });
}

function rawEventData(event: unknown): unknown {
  if (event && typeof event === "object" && "data" in event) {
    return (event as { data: unknown }).data;
  }
  return event;
}

export function messageDataToString(data: unknown): string {
  const raw = rawEventData(data);
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) {
    return new TextDecoder().decode(raw);
  }
  if (raw instanceof Uint8Array) {
    return new TextDecoder().decode(raw);
  }
  if (ArrayBuffer.isView(raw)) {
    return new TextDecoder().decode(
      new Uint8Array(raw.buffer as ArrayBuffer, raw.byteOffset, raw.byteLength),
    );
  }
  return String(raw);
}

export function parseProtocolMessage(event: unknown): WsProtocolMessage {
  return JSON.parse(messageDataToString(event)) as WsProtocolMessage;
}

export function appServerSocketOptions(
  authToken: string | undefined,
): AppServerSocketOptions | undefined {
  if (authToken === undefined) {
    return undefined;
  }
  const token = authToken.trim();
  if (!token) {
    throw new Error("app-server auth token must not be empty");
  }
  return { headers: { Authorization: `Bearer ${token}` } };
}
