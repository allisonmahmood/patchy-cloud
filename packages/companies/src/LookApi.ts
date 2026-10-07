/**
 * The `look` group of the Patchy API, over `Looks` and `Users`: any active member reads the
 * company's look, and admins publish and restore it. A refused member hears who the admins are,
 * so their agent can say who to ask. Publish and restore report business events after commit.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { Analytics } from "@patchy/analytics";
import {
  AdminRequired,
  BadRequest,
  CurrentIdentity,
  decodeBody,
  InvalidLook,
  CompanyLook,
  LookPublished,
  LookPublishRequest,
  LookRestored,
  LookRestoreRequest,
  LookRevisionUnavailable,
  PatchyApi,
  PayloadTooLarge,
  readBody,
  refuse
} from "@patchy/api";
import { registry } from "@patchy/limits/registry";
import { withReportedCommit } from "@patchy/sql";
import * as Looks from "./Looks.js";
import * as Users from "./Users.js";

const encodeLook = Schema.encodeSync(CompanyLook);
const decodePublish = decodeBody(LookPublishRequest);
const decodeRestore = decodeBody(LookRestoreRequest);
const noStore = { headers: { "cache-control": "private, no-store" } };
// JSON escaping can grow the files; their own size is checked after decoding.
const maxPublishBodyBytes = registry["look.bytes"].default * 3;
const maxRestoreBodyBytes = 4096;
const bodyFailures = {
  MalformedBody: (error: { readonly message: string }) =>
    Effect.succeed(refuse(BadRequest, { ok: false, error: error.message })),
  BodyTooLarge: () =>
    Effect.succeed(refuse(PayloadTooLarge, { ok: false, error: "Request body is too large." }))
};
const wireRevision = (revision: Looks.Revision) => ({
  revision: revision.revision,
  author: revision.author,
  createdAt: revision.createdAt.toISOString(),
  note: revision.note
});
const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** "Ada", "Ada or Cleo", "Ada, Cleo or Dot". */
const either = (names: ReadonlyArray<string>) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;

export const layer = HttpApiBuilder.group(PatchyApi, "look", (handlers) =>
  Effect.gen(function* () {
    const looks = yield* Looks.Looks;
    const users = yield* Users.Users;
    const analytics = yield* Analytics.Analytics;

    /** The refusal a member gets, or null for an admin. */
    const adminOnly = Effect.fn("LookApi.adminOnly")(function* () {
      const identity = yield* CurrentIdentity;
      if (identity.role === "admin") return null;
      const admins = (yield* users.list(identity.company.id))
        .filter((user) => user.role === "admin" && user.deactivatedAt === null)
        .map(({ id, name }) => ({ id, name }));
      return refuse(AdminRequired, {
        ok: false,
        code: "admin_required",
        error: `Only an admin can change ${identity.company.name}'s look. Ask ${either(admins.map(({ name }) => name))}.`,
        admins
      });
    });

    return handlers
      .handle("getLook", () =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const look = yield* looks.read(identity.company.id);
          return HttpServerResponse.jsonUnsafe(
            encodeLook(
              new CompanyLook({
                current:
                  look.current === null
                    ? null
                    : { ...wireRevision(look.current), files: look.current.files },
                revisions: look.revisions.map(wireRevision)
              })
            ),
            noStore
          );
        }).pipe(Effect.orDie)
      )
      .handleRaw("publishLook", () =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const refused = yield* adminOnly();
          if (refused !== null) return refused;
          const payload = yield* readBody(maxPublishBodyBytes).pipe(
            Effect.flatMap(decodePublish),
            Effect.catchTags(bodyFailures)
          );
          if (HttpServerResponse.isHttpServerResponse(payload)) return payload;
          const published = yield* withReportedCommit(
            looks.publish({
              companyId: identity.company.id,
              authorId: identity.user.id,
              note: payload.note,
              files: payload.files
            }),
            ({ current, from }) =>
              Effect.gen(function* () {
                yield* analytics.track({
                  name: "look.published",
                  principalId: identity.user.id,
                  companyId: identity.company.id,
                  properties: {
                    revision: current.revision,
                    fromRevision: from,
                    bytes: Object.values(payload.files).reduce(
                      (total, text) => total + utf8Bytes(text),
                      0
                    ),
                    logo: payload.files["logo.svg"] !== undefined,
                    ...(yield* Analytics.CurrentCli)
                  }
                });
              })
          ).pipe(
            Effect.catchTags({
              InvalidLook: (error) =>
                Effect.succeed(
                  refuse(InvalidLook, {
                    ok: false,
                    code: "invalid_look",
                    error: error.message,
                    errors: error.errors
                  })
                )
            })
          );
          if (HttpServerResponse.isHttpServerResponse(published)) return published;
          return new LookPublished({ ok: true, current: wireRevision(published.current) });
        }).pipe(Effect.orDie)
      )
      .handleRaw("restoreLook", () =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const refused = yield* adminOnly();
          if (refused !== null) return refused;
          const payload = yield* readBody(maxRestoreBodyBytes).pipe(
            Effect.flatMap(decodeRestore),
            Effect.catchTags(bodyFailures)
          );
          if (HttpServerResponse.isHttpServerResponse(payload)) return payload;
          const restored = yield* withReportedCommit(
            looks.restore({ companyId: identity.company.id, revision: payload.revision }),
            ({ current, from }) =>
              Effect.gen(function* () {
                const revision = current?.revision ?? null;
                if (revision === from) return;
                yield* analytics.track({
                  name: "look.restored",
                  principalId: identity.user.id,
                  companyId: identity.company.id,
                  properties: { revision, fromRevision: from, ...(yield* Analytics.CurrentCli) }
                });
              })
          ).pipe(
            Effect.catchTags({
              LookRevisionUnavailable: (error) =>
                Effect.succeed(
                  refuse(LookRevisionUnavailable, {
                    ok: false,
                    code: "revision_unavailable",
                    error: `${identity.company.name} has no look revision ${error.revision}.`
                  })
                )
            })
          );
          if (HttpServerResponse.isHttpServerResponse(restored)) return restored;
          return new LookRestored({
            ok: true,
            current: restored.current === null ? null : wireRevision(restored.current)
          });
        }).pipe(Effect.orDie)
      );
  })
);
