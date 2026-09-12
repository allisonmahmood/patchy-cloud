import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CURRENT_RELEASE, RuntimeGroup, WIRE_VERSION } from "@patchy/api";
import { Session } from "@patchy/auth";
import { clerkEnv, PUBLIC_BASE_URL } from "@patchy/auth/testing";
import { DEV_SEED } from "@patchy/auth/seed";
import { Companies, Users } from "@patchy/companies";
import { Limits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as LoadedVersions from "../LoadedVersions.js";
import * as Runtime from "../Runtime.js";
import * as RuntimeApi from "../RuntimeApi.js";
import * as RuntimeLog from "../RuntimeLog.js";
import { me } from "../me.js";

export const patchId = "runtimepatch";
export const versionId = "ver_aaaaaaaaaaaaaaaaaaaaaaaa";
export const publicVersionId = "ver_bbbbbbbbbbbbbbbbbbbbbbbb";
const manifest = {
  manifestVersion: 1,
  release: CURRENT_RELEASE,
  tier: 0 as const,
  tables: {},
  files: {},
  uses: {}
};
const versions = Layer.succeed(LoadedVersions.LoadedVersions, {
  find: (patch, version = versionId) =>
    Effect.succeed(
      ![patchId, "secondpatch1"].includes(patch) || ![versionId, publicVersionId].includes(version)
        ? Option.none()
        : Option.some({
            patchId: patch,
            versionId: version,
            companyId: DEV_SEED.companyId,
            manifest,
            wireVersion: WIRE_VERSION,
            scope: version === publicVersionId ? ("public" as const) : ("company" as const)
          })
    )
});
const seed = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO companies (id, handle, name) VALUES ('cmp_other', 'runtime-other', 'Other')`;
    yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role, deactivated_at) VALUES
    ('usr_member', 'user_member', ${DEV_SEED.companyId}, 'member@patchy.local', 'Member', 'member', NULL),
    ('usr_other', 'user_other', 'cmp_other', 'other@patchy.local', 'Other', 'member', NULL),
    ('usr_inactive', 'user_inactive', ${DEV_SEED.companyId}, 'inactive@patchy.local', 'Inactive', 'member', now())`;
  })
);

export const layer = (handlers: Readonly<Record<string, Runtime.Handler>> = { me }) =>
  Layer.mergeAll(RuntimeApi.layer, HttpServer.layerServices).pipe(
    Layer.provideMerge(Runtime.layer(handlers)),
    Layer.provideMerge(
      Layer.mergeAll(
        versions,
        Limits.layer,
        RuntimeLog.layer,
        Session.layer,
        Users.layer,
        Companies.layer
      )
    ),
    Layer.provideMerge(seed.pipe(Layer.provideMerge(Testing.layer()))),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ ...clerkEnv(), PATCHY_RUNTIME_CALLS_PER_MINUTE: "3" })
      )
    )
  );

// Only the outgoing encoder is permissive, so tests can send hostile bodies.
// HttpApiTest uses the real RuntimeApi group's handler routes and admission.
const TestApi = HttpApi.make("patchy").add(
  RuntimeGroup.add(
    HttpApiEndpoint.post("call", "/api/runtime/call", {
      headers: Schema.Record(Schema.String, Schema.String),
      payload: Schema.Unknown,
      success: Schema.Unknown
    })
  )
);
export const client = HttpApiTest.groups(TestApi, ["runtime"], { baseUrl: PUBLIC_BASE_URL });
export const headers = (principal: { userId: string } | null = null) => ({
  "x-patchy-wire": String(WIRE_VERSION),
  "x-patchy-principal": JSON.stringify(principal)
});
