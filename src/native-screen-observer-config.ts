export interface NativeScreenObserverConfig {
  readerPipe: string;
  grantWireName: string;
}

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";
const MAX_READER_PIPE_LENGTH = 256;
const MAX_GRANT_WIRE_NAME_LENGTH = 256;

function invalidObserverConfig(): never {
  throw new Error("Invalid nativeScreenObserver configuration");
}

/** Validate an explicit local Windows reader/grant pair without connecting to or starting it. */
export function parseNativeScreenObserverConfig(value: unknown): NativeScreenObserverConfig | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalidObserverConfig();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalidObserverConfig();

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !Object.hasOwn(record, "readerPipe") || !Object.hasOwn(record, "grantWireName")) {
    return invalidObserverConfig();
  }

  const { readerPipe, grantWireName } = record;
  if (typeof readerPipe !== "string" || readerPipe.length > MAX_READER_PIPE_LENGTH
    || !readerPipe.startsWith(WINDOWS_PIPE_PREFIX)) {
    return invalidObserverConfig();
  }
  const pipeName = readerPipe.slice(WINDOWS_PIPE_PREFIX.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*_observer_v1$/.test(pipeName)) return invalidObserverConfig();
  if (typeof grantWireName !== "string" || grantWireName.length > MAX_GRANT_WIRE_NAME_LENGTH
    || !/^mcp__[A-Za-z0-9_]+__swift_observer_reader_grant$/.test(grantWireName)) {
    return invalidObserverConfig();
  }

  return { readerPipe, grantWireName };
}
