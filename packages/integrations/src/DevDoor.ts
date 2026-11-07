/**
 * `patchy dev`'s side of the instance's dev door (ADR-0013). An integration that reads the real
 * connection in dev sends each read there as the machine token's person, whichever local viewer
 * asked. The token stays in this process's memory, out of workerd, generated files and logs. The
 * instance decides everything; its refusals reach the patch as it sent them.
 */
import {
  DEV_ATTACHMENT_HEADER,
  DEV_ATTACHMENT_PATH,
  DEV_READ_PATH,
  type DevAttachment,
  DevAttachmentMeta,
  type DevRead,
  RateLimited,
  RuntimeFailure,
  RuntimeSuccess
} from "@patchy/api";
import { Cryptography } from "@patchy/core";
import { registry } from "@patchy/limits/registry";
import { Runtime } from "@patchy/runtime/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

/** The instance refused this machine's key, before or while the read waited. */
export class KeyRefused extends Schema.TaggedError<KeyRefused>()("DevDoorKeyRefused", {
  correlationId: Schema.optionalKey(Schema.String)
}) {
  readonly code = "access_denied" as const;
  readonly status = 403;
  override get message() {
    return "The instance refused this machine's key: it expired or was revoked, or your account was deactivated. Run `patchy login`, then `patchy dev stop` and `patchy dev`.";
  }
}

const integrations: Readonly<Record<DevRead["op"] | DevAttachment["op"], string>> = {
  "posthog.query": "PostHog",
  "pidgeon.read": "Pidgeon",
  "attio.listRecords": "Attio",
  "attio.getRecord": "Attio",
  "attio.getManyRecords": "Attio",
  "attio.listEntries": "Attio",
  "attio.getEntry": "Attio",
  "attio.listMembers": "Attio",
  "imap.listFolders": "IMAP",
  "imap.folderStatus": "IMAP",
  "imap.scanMessages": "IMAP",
  "imap.listMessages": "IMAP",
  "imap.searchMessages": "IMAP",
  "imap.getMessages": "IMAP",
  "imap.stageAttachment": "IMAP"
};

/** The instance couldn't be reached, or answered with something other than its wire. */
export class InstanceUnavailable extends Schema.TaggedError<InstanceUnavailable>()(
  "DevDoorInstanceUnavailable",
  {
    op: Schema.Literals([
      "posthog.query",
      "pidgeon.read",
      "attio.listRecords",
      "attio.getRecord",
      "attio.getManyRecords",
      "attio.listEntries",
      "attio.getEntry",
      "attio.listMembers",
      "imap.listFolders",
      "imap.folderStatus",
      "imap.scanMessages",
      "imap.listMessages",
      "imap.searchMessages",
      "imap.getMessages",
      "imap.stageAttachment"
    ]),
    instance: Schema.String,
    cause: Schema.optionalKey(Schema.Redacted(Schema.Defect()))
  }
) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  override get message() {
    return `patchy dev couldn't read ${integrations[this.op]} through ${this.instance}: it can't be reached or answered unexpectedly. Other dev work keeps going.`;
  }
}

/** The instance refused the read; the patch sees the refusal the instance sent. */
export class Refused extends Schema.TaggedError<Refused>()("DevDoorRefused", {
  status: Schema.Int,
  failure: RuntimeFailure
}) {
  get code() {
    return this.failure.code;
  }
  override get message() {
    return this.failure.error;
  }
  get retryAfterSeconds() {
    return this.failure.retryAfter;
  }
  get limitId() {
    return this.failure.limitId;
  }
  get scope() {
    return this.failure.scope;
  }
  get value() {
    return this.failure.value;
  }
  get details() {
    return this.failure.details;
  }
  get correlationId() {
    return this.failure.correlationId;
  }
  get integrationOperation() {
    return this.failure.operation;
  }
}

const decodeSuccess = Schema.decodeUnknownOption(RuntimeSuccess);
const decodeMeta = Schema.decodeUnknownOption(Schema.fromJsonString(DevAttachmentMeta));
const decodeFailure = Schema.decodeUnknownOption(RuntimeFailure);
const decodeGuard = Schema.decodeUnknownOption(RateLimited);

/**
 * What a response other than 200 says, in the instance's wire: a refused key whatever its body
 * says, a runtime failure as sent, or the per-address limit that answers before the door.
 */
const refused = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
  failed: (cause?: unknown) => InstanceUnavailable
) {
  const body = yield* Effect.result(response.json);
  const failure =
    body._tag === "Success" ? decodeFailure(body.success) : Option.none<RuntimeFailure>();
  if (response.status === 401)
    return yield* new KeyRefused(
      Option.isSome(failure) && failure.value.correlationId !== undefined
        ? { correlationId: failure.value.correlationId }
        : {}
    );
  if (body._tag === "Failure") return yield* failed(body.failure);
  if (Option.isSome(failure))
    return yield* new Refused({ status: response.status, failure: failure.value });
  const guard = response.status === 429 ? decodeGuard(body.success) : Option.none();
  if (Option.isSome(guard))
    return yield* new Refused({
      status: 429,
      failure: {
        ok: false,
        source: "patchy",
        code: "rate_limited",
        error: `The instance is limiting requests from this address. Try again in ${guard.value.retryAfterSeconds} seconds.`,
        limitId: "rate.protectedApi.perMinute",
        scope: registry["rate.protectedApi.perMinute"].scope,
        retryAfter: guard.value.retryAfterSeconds
      }
    });
  return yield* failed();
});

/** Where the instance is and the key dev reads with; absent when no live integration is declared. */
export interface Instance {
  readonly apiUrl: string;
  readonly token: Option.Option<Redacted.Redacted>;
}

/**
 * One read through the door: the instance's answer through `decode`, which holds it to the
 * operation's wire, or the refusal the instance sent. The local runtime's deadline interrupts the
 * request; the instance keeps its own.
 */
export const read = Effect.fn("DevDoor.read")(function* <A>(
  instance: Instance,
  /** The arguments are the instance's to check; `decode` holds the answer to the wire. */
  payload: Pick<DevRead, "op" | "connection"> & { readonly args: unknown },
  decode: (value: unknown) => Option.Option<A>
) {
  const http = yield* HttpClient.HttpClient;
  const failed = (cause?: unknown) =>
    new InstanceUnavailable({
      op: payload.op,
      instance: instance.apiUrl,
      ...(cause === undefined ? {} : { cause: Redacted.make(cause) })
    });
  if (Option.isNone(instance.token)) return yield* new KeyRefused({});
  const response = yield* http
    .execute(
      HttpClientRequest.post(`${instance.apiUrl}/api${DEV_READ_PATH}`).pipe(
        HttpClientRequest.bearerToken(instance.token.value),
        HttpClientRequest.bodyJsonUnsafe(payload)
      )
    )
    .pipe(Effect.mapError(failed));
  if (response.status === 200) {
    const body = yield* Effect.result(response.json);
    if (body._tag === "Failure") return yield* failed(body.failure);
    const value = Option.flatMap(decodeSuccess(body.success), (success) => decode(success.value));
    return Option.isSome(value) ? value.value : yield* failed();
  }
  return yield* refused(response, failed);
});

/**
 * One attachment through the door: its bytes, read up to `maxBytes`, held to the size and sha256
 * the instance stated before the caller stages anything. A transfer that ends short or differs is
 * `InstanceUnavailable`; one past `maxBytes` is refused `too_large` as it streams, read no further.
 */
export const attachment = Effect.fn("DevDoor.attachment")(function* (
  instance: Instance,
  payload: DevAttachment,
  maxBytes: number
) {
  const http = yield* HttpClient.HttpClient;
  const cryptography = yield* Cryptography.Cryptography;
  const failed = (cause?: unknown) =>
    new InstanceUnavailable({
      op: payload.op,
      instance: instance.apiUrl,
      ...(cause === undefined ? {} : { cause: Redacted.make(cause) })
    });
  if (Option.isNone(instance.token)) return yield* new KeyRefused({});
  const response = yield* http
    .execute(
      HttpClientRequest.post(`${instance.apiUrl}/api${DEV_ATTACHMENT_PATH}`).pipe(
        HttpClientRequest.bearerToken(instance.token.value),
        HttpClientRequest.bodyJsonUnsafe(payload)
      )
    )
    .pipe(Effect.mapError(failed));
  if (response.status !== 200) return yield* refused(response, failed);
  const header = response.headers[DEV_ATTACHMENT_HEADER];
  const meta = decodeMeta(
    header === undefined ? "" : Buffer.from(header, "base64url").toString("utf8")
  );
  if (Option.isNone(meta)) return yield* failed();
  const tooLarge = new Runtime.TooLarge({ maxBytes, limitId: "files.stage.bytes" });
  if (meta.value.size > maxBytes) return yield* tooLarge;
  const chunks: Uint8Array[] = [];
  let received = 0;
  yield* response.stream.pipe(
    Stream.runForEach((chunk) => {
      received += chunk.byteLength;
      if (received > maxBytes) return Effect.fail(tooLarge);
      chunks.push(chunk);
      return Effect.void;
    }),
    Effect.catchTag("HttpClientError", (cause) => Effect.fail(failed(cause)))
  );
  const bytes = new Uint8Array(Buffer.concat(chunks, received));
  if (received !== meta.value.size || (yield* cryptography.sha256(bytes)) !== meta.value.sha256)
    return yield* failed(new Error("The attachment's transfer ended short or differed."));
  return { bytes, meta: meta.value };
});
