import { describe, expect, it } from "vitest";
import { Analytics, PostHogClient } from "@patchy/analytics";
import type { ServerConfig } from "@patchy/config";
import type { ExpirySweep } from "@patchy/patches";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { sweepExpiredPatches } from "./runtime.js";
import { createTestApp, type TestApp } from "./test-harness.js";
import { recordingAnalytics } from "./testing.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINT_PATH = "/api/tokens/self-service";

/** The reporting layer over a PostHog backend that is down. */
const failingAnalytics = Analytics.layerPostHog.pipe(
  Layer.provide(
    Layer.succeed(
      PostHogClient.PostHogClient,
      PostHogClient.PostHogClient.of({
        capture: () =>
          new PostHogClient.PostHogError({
            operation: "capture",
            cause: new Error("Forced analytics failure.")
          }),
        shutdown: Effect.void
      })
    )
  )
);

const names = (events: Analytics.AnalyticsEvent[]) => events.map((event) => event.name);

const only = (events: Analytics.AnalyticsEvent[]): Analytics.AnalyticsEvent => {
  expect(events).toHaveLength(1);
  return events[0] as Analytics.AnalyticsEvent;
};

interface WatchedApp {
  readonly app: TestApp["app"];
  /** What the recording layer kept; empty when a test brought its own layer. */
  readonly events: Analytics.AnalyticsEvent[];
  advanceDays(days: number): void;
  createPatch(title: string, token?: string): Promise<string>;
  sweep(): Promise<ExpirySweep.SweepResult>;
  close(): Promise<void>;
}

/**
 * An app wired to a recording layer, with the clock its database also reads,
 * so a test can wind the retention clock forward and sweep.
 */
async function createWatchedApp(
  options: { analytics?: Layer.Layer<Analytics.Analytics>; config?: Partial<ServerConfig> } = {}
): Promise<WatchedApp> {
  let now = Date.UTC(2026, 0, 1);
  const recording = recordingAnalytics();
  const harness = await createTestApp({
    clock: () => now,
    config: options.config,
    analytics: options.analytics ?? recording.layer
  });

  return {
    app: harness.app,
    events: recording.events,
    advanceDays(days) {
      now += days * DAY_MS;
    },
    async createPatch(title, token = "dev-token") {
      const upload = await harness.app.inject({
        method: "POST",
        url: "/api/uploads",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          html: `<!doctype html><html><head><title>${title}</title></head><body><p>x</p></body></html>`
        }
      });
      expect(upload.statusCode).toBe(201);
      return (upload.json() as { patchId: string }).patchId;
    },
    sweep: () => sweepExpiredPatches(harness.runtime),
    close: () => harness.close()
  };
}

describe("server-side analytics", () => {
  it("reports a self-service mint as one event on the principal it created", async () => {
    const watched = await createWatchedApp({
      config: { allowSelfServiceTokens: true }
    });

    const mint = await watched.app.inject({
      method: "POST",
      url: MINT_PATH,
      headers: { "content-type": "application/json" },
      payload: "{}",
      remoteAddress: "203.0.113.9"
    });
    expect(mint.statusCode).toBe(201);
    const minted = (mint.json() as { token: string }).token;

    const me = await watched.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${minted}` }
    });
    const principal = me.json() as { accountId: string; apiTokenId: string };

    expect(only(watched.events)).toEqual({
      name: "token.minted",
      principalId: principal.accountId,
      properties: { apiTokenId: principal.apiTokenId, selfService: true }
    });

    await watched.close();
  });

  it("reports an operator-issued token as a mint that was not self-service", async () => {
    const watched = await createWatchedApp();

    const created = await watched.app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { authorization: "Bearer dev-token" },
      payload: { name: "Teammate", scopes: ["upload"] }
    });
    expect(created.statusCode).toBe(201);
    const apiToken = (created.json() as { apiToken: { id: string } }).apiToken;

    const event = only(watched.events);
    expect(event.name).toBe("token.minted");
    expect(event.properties).toEqual({ apiTokenId: apiToken.id, selfService: false });
    // The plaintext exists in that response and must never leave through here.
    expect(JSON.stringify(event)).not.toContain("pp_");
    // Nor the name an operator chose for it.
    expect(JSON.stringify(event)).not.toContain("Teammate");

    await watched.close();
  });

  it("reports nothing when a mint is refused", async () => {
    const watched = await createWatchedApp();

    const mint = await watched.app.inject({
      method: "POST",
      url: MINT_PATH,
      headers: { "content-type": "application/json" },
      payload: "{}"
    });
    expect(mint.statusCode).toBe(403);
    expect(watched.events).toEqual([]);

    await watched.close();
  });

  it("reports a created draft and then an updated one, with its size and version", async () => {
    const watched = await createWatchedApp();

    const patchId = await watched.createPatch("First");
    const update = await watched.app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        patchId: patchId,
        html: "<!doctype html><html><head><title>Second</title></head><body></body></html>"
      }
    });
    expect(update.statusCode).toBe(200);

    expect(names(watched.events)).toEqual(["patch.created", "patch.updated"]);
    const [created, updated] = watched.events as [
      Analytics.AnalyticsEvent,
      Analytics.AnalyticsEvent
    ];
    expect(created.properties.patchId).toBe(patchId);
    expect(created.properties.versionNumber).toBe(1);
    expect(created.properties.htmlBytes).toBeGreaterThan(0);
    expect(typeof created.properties.apiTokenId).toBe("string");
    expect(created.principalId).toBe(updated.principalId);
    expect(updated.properties.patchId).toBe(patchId);
    expect(updated.properties.versionNumber).toBe(2);

    await watched.close();
  });

  it("reports nothing when an upload is refused", async () => {
    const watched = await createWatchedApp();

    const invalid = await watched.app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: { html: "<script>alert(1)</script>" }
    });
    expect(invalid.statusCode).toBe(422);
    expect(watched.events).toEqual([]);

    await watched.close();
  });

  it("reports a disabled draft and a deleted one, marking who acted", async () => {
    const watched = await createWatchedApp();
    const disabledId = await watched.createPatch("To disable");
    const deletedId = await watched.createPatch("To delete");
    watched.events.length = 0;

    const disable = await watched.app.inject({
      method: "POST",
      url: `/api/patches/${disabledId}/disable`,
      headers: { authorization: "Bearer dev-token" },
      payload: { reason: "Reported and reviewed." }
    });
    expect(disable.statusCode).toBe(200);

    const remove = await watched.app.inject({
      method: "DELETE",
      url: `/api/patches/${deletedId}`,
      headers: { authorization: "Bearer dev-token" }
    });
    expect(remove.statusCode).toBe(200);

    expect(names(watched.events)).toEqual(["patch.disabled", "patch.deleted"]);
    const [disabled, deleted] = watched.events as [
      Analytics.AnalyticsEvent,
      Analytics.AnalyticsEvent
    ];
    expect(disabled.properties).toEqual({ patchId: disabledId, admin: true });
    expect(deleted.properties).toEqual({ patchId: deletedId, admin: true });
    // The reason an operator typed is moderation state, not an event property.
    expect(JSON.stringify(watched.events)).not.toContain("Reported and reviewed.");

    await watched.close();
  });

  it("marks a draft its own owner disabled or deleted as not an operator's act", async () => {
    const watched = await createWatchedApp({
      config: { allowSelfServiceTokens: true }
    });

    const mint = await watched.app.inject({
      method: "POST",
      url: MINT_PATH,
      headers: { "content-type": "application/json" },
      payload: "{}",
      remoteAddress: "203.0.113.14"
    });
    expect(mint.statusCode).toBe(201);
    const owner = (mint.json() as { token: string }).token;

    const disabledId = await watched.createPatch("Mine to disable", owner);
    const deletedId = await watched.createPatch("Mine to delete", owner);
    watched.events.length = 0;

    const disable = await watched.app.inject({
      method: "POST",
      url: `/api/patches/${disabledId}/disable`,
      headers: { authorization: `Bearer ${owner}` }
    });
    expect(disable.statusCode).toBe(200);

    const remove = await watched.app.inject({
      method: "DELETE",
      url: `/api/patches/${deletedId}`,
      headers: { authorization: `Bearer ${owner}` }
    });
    expect(remove.statusCode).toBe(200);

    expect(names(watched.events)).toEqual(["patch.disabled", "patch.deleted"]);
    const [disabled, deleted] = watched.events as [
      Analytics.AnalyticsEvent,
      Analytics.AnalyticsEvent
    ];
    expect(disabled.properties).toEqual({ patchId: disabledId, admin: false });
    expect(deleted.properties).toEqual({ patchId: deletedId, admin: false });

    await watched.close();
  });

  it("reports nothing when a moderation request finds no draft", async () => {
    const watched = await createWatchedApp();

    const disable = await watched.app.inject({
      method: "POST",
      url: "/api/patches/drf_00000000000000000000000000/disable",
      headers: { authorization: "Bearer dev-token" }
    });
    expect(disable.statusCode).toBe(404);

    const remove = await watched.app.inject({
      method: "DELETE",
      url: "/api/patches/drf_00000000000000000000000000",
      headers: { authorization: "Bearer dev-token" }
    });
    expect(remove.statusCode).toBe(404);
    expect(watched.events).toEqual([]);

    await watched.close();
  });

  it("reports an expired draft when the sweep takes it, on no principal at all", async () => {
    const watched = await createWatchedApp();
    const patchId = await watched.createPatch("Ages out");
    watched.events.length = 0;

    watched.advanceDays(91);
    const result = await watched.sweep();
    expect(result.deleted).toBe(1);

    expect(only(watched.events)).toEqual({
      name: "patch.expired",
      principalId: null,
      properties: { patchId, versionsRemoved: 1 }
    });

    await watched.close();
  });

  it("reports nothing when a sweep takes nothing", async () => {
    const watched = await createWatchedApp();
    await watched.createPatch("Still fresh");
    watched.events.length = 0;

    const result = await watched.sweep();
    expect(result.deleted).toBe(0);
    expect(watched.events).toEqual([]);

    await watched.close();
  });

  it("reports nothing when a draft is served, at either URL", async () => {
    const watched = await createWatchedApp();
    const patchId = await watched.createPatch("Read me");
    watched.events.length = 0;

    const latest = await watched.app.inject({ method: "GET", url: `/d/${patchId}` });
    expect(latest.statusCode).toBe(200);
    const version = await watched.app.inject({ method: "GET", url: `/d/${patchId}/v/1` });
    expect(version.statusCode).toBe(200);

    // Readers are unwatched: a visit moves a retention clock and is reported
    // nowhere, and nothing analytics-shaped reaches the page either.
    expect(watched.events).toEqual([]);
    for (const response of [latest, version]) {
      expect(response.body).not.toContain("posthog");
      expect(response.body).not.toContain("<script");
      // No cookie, and a policy that admits no script source at all: scripts
      // fall to `default-src 'none'` and no directive re-opens them. There is
      // nowhere for analytics JavaScript to arrive from even if something one
      // day tried to put it on the page.
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(response.headers["content-security-policy"]).not.toContain("script-src");
    }

    await watched.close();
  });

  it("reports nothing for the routes that are not on the list", async () => {
    const watched = await createWatchedApp();
    const patchId = await watched.createPatch("Pinned");
    watched.events.length = 0;

    for (const suffix of ["pin", "unpin"]) {
      const response = await watched.app.inject({
        method: "POST",
        url: `/api/patches/${patchId}/${suffix}`,
        headers: { authorization: "Bearer dev-token" }
      });
      expect(response.statusCode).toBe(200);
    }

    const me = await watched.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: "Bearer dev-token" }
    });
    expect(me.statusCode).toBe(200);

    // Those six are the whole list. Pinning, unpinning, and reading are things
    // that happen; they are not moments the instance reports.
    expect(watched.events).toEqual([]);

    await watched.close();
  });

  it("answers every request normally when capture fails", async () => {
    const watched = await createWatchedApp({
      analytics: failingAnalytics,
      config: { allowSelfServiceTokens: true }
    });

    const mint = await watched.app.inject({
      method: "POST",
      url: MINT_PATH,
      headers: { "content-type": "application/json" },
      payload: "{}",
      remoteAddress: "203.0.113.11"
    });
    expect(mint.statusCode).toBe(201);
    expect((mint.json() as { token: string }).token).toMatch(/^pp_/);

    const patchId = await watched.createPatch("Survives");

    const update = await watched.app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { authorization: "Bearer dev-token" },
      payload: {
        patchId: patchId,
        html: "<!doctype html><html><head><title>Again</title></head><body></body></html>"
      }
    });
    expect(update.statusCode).toBe(200);

    const disable = await watched.app.inject({
      method: "POST",
      url: `/api/patches/${patchId}/disable`,
      headers: { authorization: "Bearer dev-token" }
    });
    expect(disable.statusCode).toBe(200);

    const remove = await watched.app.inject({
      method: "DELETE",
      url: `/api/patches/${patchId}`,
      headers: { authorization: "Bearer dev-token" }
    });
    expect(remove.statusCode).toBe(200);

    await watched.close();
  });

  it("finishes the expiry sweep when capture fails", async () => {
    const watched = await createWatchedApp({
      analytics: failingAnalytics
    });
    await watched.createPatch("Ages out");

    watched.advanceDays(91);
    const result = await watched.sweep();

    expect(result).toEqual({ deleted: 1, skipped: 0, failed: 0, orphanedObjects: 0 });

    await watched.close();
  });
});
