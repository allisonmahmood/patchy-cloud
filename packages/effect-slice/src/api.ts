/**
 * The `packages/api` shape: wire schemas, the bearer middleware contract, and
 * the `HttpApi` both the server and the CLI client derive from. No server code.
 */
import { Context, Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSecurity
} from "effect/unstable/httpapi";

/** What `GET /api/me` returns today, byte for byte. */
export class Identity extends Schema.Class<Identity>("Identity")({
  accountId: Schema.String,
  accountName: Schema.String,
  apiTokenId: Schema.String,
  apiTokenName: Schema.String,
  scopes: Schema.Array(Schema.String)
}) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { error: Schema.String },
  { httpApiStatus: 401 }
) {}

export class CurrentIdentity extends Context.Service<CurrentIdentity, Identity>()(
  "@patchy/effect-slice/api/CurrentIdentity"
) {}

export class Authorization extends HttpApiMiddleware.Service<
  Authorization,
  { provides: CurrentIdentity; requires: never }
>()("@patchy/effect-slice/api/Authorization", {
  requiredForClient: true,
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized
}) {}

export class MeGroup extends HttpApiGroup.make("me", { topLevel: true })
  .add(HttpApiEndpoint.get("me", "/me", { success: Identity }))
  .middleware(Authorization)
  .prefix("/api") {}

export class PatchyApi extends HttpApi.make("patchy").add(MeGroup) {}
