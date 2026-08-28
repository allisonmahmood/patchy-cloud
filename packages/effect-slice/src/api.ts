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
  HttpApiSchema,
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

/** Today's 401 body, byte for byte: `{ ok: false, error }`. Not a TaggedError — no `_tag` on the wire. */
export const Unauthorized = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.String
}).pipe(HttpApiSchema.status(401));
export type Unauthorized = typeof Unauthorized.Type;

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
