import type { Page } from "playwright-core";
import { setTimeout as delay } from "node:timers/promises";
import { ChatGptWebAdapterError } from "./adapter-error";

/** Runs inside ChatGPT. Credentials stay in the page; only routing evidence leaves it. */
type ConnectorRouteEvidence = { connectorId: string } | "mismatch" | "duplicate" | "unverified";

// Retries only run before Send and before touching the composer. A verified
// wrong tunnel or duplicate named connector is never retried or guessed.
export const CONNECTOR_ROUTE_MAX_PROBES = 4;
const CONNECTOR_ROUTE_RETRY_DELAYS_MS = [250, 650, 1200] as const;

async function readConnectorRoute(input: { appName: string; expectedTunnelId: string }): Promise<ConnectorRouteEvidence> {
  try {
    const signal = AbortSignal.timeout(15_000);
    const sessionResponse = await fetch("/api/auth/session", {
      credentials: "same-origin", cache: "no-store", redirect: "error", signal,
    });
    if (!sessionResponse.ok) return "unverified";
    const session = await sessionResponse.json();
    if (typeof session?.accessToken !== "string" || !session.accessToken) return "unverified";
    const headers = { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json" };
    const linksResponse = await fetch("/backend-api/aip/connectors/links/list_accessible", {
      method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal, headers,
      body: JSON.stringify({ principals: [], link_refresh_strategy: "BLOCKING" }),
    });
    if (!linksResponse.ok) return "unverified";
    const catalog = await linksResponse.json();
    if (!Array.isArray(catalog?.links)) return "unverified";
    const ids = new Set<string>();
    for (const link of catalog.links) {
      // Link labels survive app renames; the registered connector name owns the menu identity.
      if ((typeof link?.connector_name === "string" ? link.connector_name : link?.name) !== input.appName) continue;
      if (typeof link.connector_id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(link.connector_id)) return "unverified";
      ids.add(link.connector_id);
    }
    if (ids.size > 1) return "duplicate";
    if (ids.size !== 1) return "unverified";
    const id = [...ids][0]!;
    const connectorResponse = await fetch(`/backend-api/aip/connectors/${encodeURIComponent(id)}`, {
      credentials: "same-origin", cache: "no-store", redirect: "error", signal, headers,
    });
    if (!connectorResponse.ok) return "unverified";
    const connector = await connectorResponse.json();
    if (connector?.id !== id || connector.name !== input.appName
      || typeof connector.tunnel_id !== "string" || !/^tunnel_[a-f0-9]{32}$/.test(connector.tunnel_id)) return "unverified";
    return connector.tunnel_id === input.expectedTunnelId ? { connectorId: id } : "mismatch";
  } catch {
    // Never serialize session/API errors or response bodies into browser-helper logs.
    return "unverified";
  }
}

export async function assertChatGptConnectorRoute(
  page: Page,
  appName: string,
  expectedTunnelId?: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (expectedTunnelId === undefined) return;
  const eligible = (() => {
    try {
      return new URL(page.url()).origin === "https://chatgpt.com"
        && /^tunnel_[a-f0-9]{32}$/.test(expectedTunnelId);
    } catch { return false; }
  })();
  let result: ConnectorRouteEvidence = "unverified";
  if (eligible) {
    for (let probe = 0; probe < CONNECTOR_ROUTE_MAX_PROBES; probe++) {
      signal?.throwIfAborted();
      // A temporary catalog/cache/session miss is common while ChatGPT is
      // hydrating a tab. Re-read current evidence; never reuse an old ID.
      try {
        result = await page.evaluate(readConnectorRoute, { appName, expectedTunnelId });
      } catch {
        // Page transitions can reject evaluation before any composer action.
        result = "unverified";
      }
      signal?.throwIfAborted();
      if (typeof result === "object") return result.connectorId;
      if (result !== "unverified") break;
      if (probe < CONNECTOR_ROUTE_MAX_PROBES - 1) {
        console.info(`[chatgpt-web] connector_route_not_ready probe=${probe + 1} maxProbes=${CONNECTOR_ROUTE_MAX_PROBES}`);
        await delay(CONNECTOR_ROUTE_RETRY_DELAYS_MS[probe]!, undefined, { signal });
      }
    }
  }
  if (result === "unverified") {
    console.warn(`[chatgpt-web] connector_route_unverified afterProbes=${eligible ? CONNECTOR_ROUTE_MAX_PROBES : 0}`);
  }
  throw new ChatGptWebAdapterError(result === "mismatch"
    ? `ChatGPT connector ${JSON.stringify(appName)} points to a different tunnel than this local runtime. Open its plugin settings and connect it to the tunnel configured in the Launcher MCP panel before retrying.`
    : `Could not verify the tunnel for ChatGPT connector ${JSON.stringify(appName)}. Check that exactly one connector with this name is connected to the tunnel configured in the Launcher MCP panel, then verify the runtime again.`, {
    status: result === "mismatch" ? 409 : 503,
    errorType: "connector_error",
    code: result === "mismatch" ? "connector_tunnel_mismatch" : "connector_route_unverified",
    retryable: false,
  });
}
