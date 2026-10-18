import { afterEach, expect, spyOn, test } from "bun:test";
import type { Page } from "playwright-core";
import { assertChatGptConnectorRoute, CONNECTOR_ROUTE_MAX_PROBES } from "../src/adapters/chatgpt-web/connector-routing";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

const expectedTunnel = `tunnel_${"a".repeat(32)}`;
const otherTunnel = `tunnel_${"b".repeat(32)}`;
const appName = "Codex Native2 DEV";
const connectorId = "asdk_app_dev_test";
const credential = "private-session-credential";
let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => fetchSpy?.mockRestore());

const page = {
  url: () => "https://chatgpt.com/",
  evaluate: async (fn: (input: unknown) => unknown, input: unknown) => fn(input),
} as unknown as Page;

function serveRoute(tunnelId: unknown, links: Array<{ name: string; connector_name?: string; connector_id: string }> = [{ name: appName, connector_id: connectorId }], transientCatalogFailures = 0) {
  let catalogProbes = 0;
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (input === "/api/auth/session") return Response.json({ accessToken: credential });
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${credential}`);
    expect(init?.redirect).toBe("error");
    if (input === "/backend-api/aip/connectors/links/list_accessible") {
      catalogProbes++;
      if (catalogProbes <= transientCatalogFailures) return new Response(null, { status: 503 });
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ principals: [], link_refresh_strategy: "BLOCKING" });
      return Response.json({ links });
    }
    if (input === `/backend-api/aip/connectors/${connectorId}`) {
      return Response.json({ id: connectorId, name: appName, tunnel_id: tunnelId });
    }
    throw new Error("Unexpected connector metadata request");
  };
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(fakeFetch as typeof fetch);
  return () => catalogProbes;
}

test("rejects a same-name connector routed to another runtime without disclosing identifiers or credentials", async () => {
  serveRoute(otherTunnel);
  const error = await assertChatGptConnectorRoute(page, appName, expectedTunnel).catch(error => error);
  expect(error).toMatchObject({ code: "connector_tunnel_mismatch", retryable: false });
  for (const secret of [expectedTunnel, otherTunnel, connectorId, credential]) {
    expect(String(error)).not.toContain(secret);
  }
});

test("accepts the configured connector only when its registered tunnel matches", async () => {
  serveRoute(expectedTunnel);
  expect(await assertChatGptConnectorRoute(page, appName, expectedTunnel)).toBe(connectorId);
});

test("uses the current connector name when a renamed app link still carries its old label", async () => {
  serveRoute(expectedTunnel, [
    { name: appName, connector_name: `${appName} Previous`, connector_id: "asdk_app_previous" },
    { name: appName, connector_name: appName, connector_id: connectorId },
  ]);
  await assertChatGptConnectorRoute(page, appName, expectedTunnel);
});

test("does not choose arbitrarily between duplicate connector names", async () => {
  serveRoute(expectedTunnel, [
    { name: appName, connector_id: connectorId },
    { name: appName, connector_id: "asdk_app_other" },
  ]);
  await expect(assertChatGptConnectorRoute(page, appName, expectedTunnel))
    .rejects.toMatchObject({ code: "connector_route_unverified" });
});

test("fails closed when routing metadata is unavailable", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
  await expect(assertChatGptConnectorRoute(page, appName, expectedTunnel))
    .rejects.toMatchObject({ code: "connector_route_unverified", retryable: false });
});

test("missing tunnel metadata is not treated as a verified connection", async () => {
  serveRoute(null);
  await expect(assertChatGptConnectorRoute(page, appName, expectedTunnel))
    .rejects.toMatchObject({ code: "connector_route_unverified" });
});

test("keeps legacy providers without a configured tunnel compatible", async () => {
  await assertChatGptConnectorRoute({ url: () => { throw new Error("must not inspect"); } } as unknown as Page, appName);
});

test("tool-capable connector selection rejects a wrong route before touching the composer", async () => {
  serveRoute(otherTunnel);
  const select = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: Page): Promise<unknown>;
  }).selectConnector;
  await expect(select.call({
    config: { appName, expectedConnectorTunnelId: expectedTunnel },
    activeComposer: () => { throw new Error("wrong runtime must not receive a draft"); },
  }, page)).rejects.toMatchObject({ code: "connector_tunnel_mismatch" });
});

for (const replacementMatches of [true, false]) {
  test(`clears a retained same-name pill and checks the replacement identity (${replacementMatches})`, async () => {
    serveRoute(expectedTunnel);
    let stale = true;
    let activated = false;
    let clears = 0;
    const composer = {
      fill: async () => {}, focus: async () => {}, pressSequentially: async () => {},
      press: async (key: string) => { expect(key).toBe("Enter"); activated = true; },
    };
    const result = { waitFor: async () => {}, count: async () => 1, getAttribute: async () => "" };
    const fakePage = {
      ...page, getByText: () => ({}), locator: () => ({ filter: () => result }),
    };
    const select = (ChatGptBrowserWorker.prototype as unknown as {
      selectConnector(page: unknown): Promise<unknown>;
    }).selectConnector;
    const selection = select.call({
      config: { appName, expectedConnectorTunnelId: expectedTunnel },
      activeComposer: async () => composer,
      attachedPromptText: async () => { throw new Error("stale pill must never be reused"); },
      connectorIsSelected: async (_composer: unknown, _signal: unknown, expectedId?: string) => {
        if (expectedId !== undefined) expect(expectedId).toBe(connectorId);
        return expectedId === undefined ? stale || activated : activated && replacementMatches;
      },
      clearChatGptComposerState: async () => { stale = false; activated = false; clears += 1; },
      selectedConnectorControl: () => ({ waitFor: async () => {} }),
    }, fakePage);
    if (replacementMatches) {
      expect(await selection).toBe(composer);
      expect(clears).toBe(1);
    } else {
      await expect(selection).rejects.toThrow("did not select");
      expect(clears).toBe(2);
    }
  });
}

test("rechecks a temporarily unavailable connector catalog before editing or sending a prompt", async () => {
  const probes = serveRoute(expectedTunnel, [{name:appName,connector_id:connectorId}], 2);
  expect(await assertChatGptConnectorRoute(page, appName, expectedTunnel)).toBe(connectorId);
  expect(probes()).toBe(3);
});

test("a stable wrong tunnel is refused on its first probe rather than retried", async () => {
  const probes = serveRoute(otherTunnel);
  await expect(assertChatGptConnectorRoute(page, appName, expectedTunnel))
    .rejects.toMatchObject({code:"connector_tunnel_mismatch"});
  expect(probes()).toBe(1);
});

test("an ambiguous duplicate connector name is refused without a retry or arbitrary selection", async () => {
  const probes=serveRoute(expectedTunnel, [
    {name:appName,connector_id:connectorId},
    {name:appName,connector_id:"asdk_app_different"},
  ]);
  await expect(assertChatGptConnectorRoute(page,appName,expectedTunnel))
    .rejects.toMatchObject({code:"connector_route_unverified"});
  expect(probes()).toBe(1);
});

test("a permanently unavailable catalog fails closed after a bounded number of probes", async () => {
  const probes=serveRoute(expectedTunnel, [{name:appName,connector_id:connectorId}], 10);
  await expect(assertChatGptConnectorRoute(page,appName,expectedTunnel))
    .rejects.toMatchObject({code:"connector_route_unverified",retryable:false});
  expect(probes()).toBe(CONNECTOR_ROUTE_MAX_PROBES);
});

test("cancellation during a connector catalog backoff prevents another probe", async () => {
  const controller=new AbortController();
  const probes=serveRoute(expectedTunnel, [{name:appName,connector_id:connectorId}], 3);
  const operation=assertChatGptConnectorRoute(page,appName,expectedTunnel,controller.signal);
  await Promise.resolve();
  await Promise.resolve();
  controller.abort(new DOMException("cancelled","AbortError"));
  await expect(operation).rejects.toMatchObject({name:"AbortError"});
  expect(probes()).toBeLessThanOrEqual(1);
});
