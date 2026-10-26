import { createClerkClient } from "@clerk/backend";
import { isClerkAPIResponseError } from "@clerk/backend/errors";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { newInternalId } from "@patchy/core";

export class InviteMailError extends Schema.TaggedError<InviteMailError>()("InviteMailError", {
  operation: Schema.Literals(["create", "revoke"]),
  invitationId: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect())
}) {
  override get message() {
    return `Clerk invitation ${this.operation} failed.`;
  }
}

/** Clerk has nothing left to revoke: the emailed invitation was revoked, or accepted at sign-up. */
export class InvitationNotPending extends Schema.TaggedError<InvitationNotPending>()(
  "InvitationNotPending",
  { invitationId: Schema.String, cause: Schema.optional(Schema.Defect()) }
) {
  override get message() {
    return "The emailed invitation is already revoked or accepted.";
  }
}

const notPendingCodes = new Set(["invitation_already_revoked", "invitation_already_accepted"]);

/** Backend transport override for offline tests; browser input never selects this URL. */
export const backendApiUrl = Context.Reference<string>(
  "@patchy/companies/InviteMail/backendApiUrl",
  {
    defaultValue: () => "https://api.clerk.com"
  }
);

export class InviteMail extends Context.Service<
  InviteMail,
  {
    readonly create: (
      email: string,
      redirectUrl?: string
    ) => Effect.Effect<string, InviteMailError>;
    readonly revoke: (id: string) => Effect.Effect<void, InviteMailError | InvitationNotPending>;
  }
>()("@patchy/companies/InviteMail") {}

export const make = Effect.gen(function* () {
  const secretKey = yield* Config.schema(
    Schema.Redacted(Schema.NonEmptyString),
    "CLERK_SECRET_KEY"
  );
  const client = createClerkClient({
    secretKey: Redacted.value(secretKey),
    apiUrl: yield* backendApiUrl,
    telemetry: { disabled: true }
  });
  // Company invitations keep Clerk's default Account Portal destination. A caller may
  // supply an Account Portal URL with a return destination; that page still consumes
  // the ticket, including when sign-up runs in waitlist mode.
  const create = Effect.fn("InviteMail.create")(function* (email: string, redirectUrl?: string) {
    const invitation = yield* Effect.tryPromise({
      try: () =>
        client.invitations.createInvitation({
          emailAddress: email,
          ...(redirectUrl === undefined ? {} : { redirectUrl }),
          ignoreExisting: true,
          notify: true
        }),
      catch: (cause) => new InviteMailError({ operation: "create", cause })
    });
    return invitation.id;
  });
  const revoke = Effect.fn("InviteMail.revoke")((id: string) =>
    Effect.tryPromise({
      try: () => client.invitations.revokeInvitation(id),
      catch: (cause) =>
        isClerkAPIResponseError(cause) &&
        cause.status === 400 &&
        cause.errors.length > 0 &&
        cause.errors.every((error) => notPendingCodes.has(error.code))
          ? new InvitationNotPending({ invitationId: id, cause })
          : new InviteMailError({ operation: "revoke", invitationId: id, cause })
    }).pipe(Effect.asVoid)
  );
  return InviteMail.of({ create, revoke });
});

export const layer = Layer.effect(InviteMail, make);

export type Event =
  | { readonly operation: "create"; readonly email: string; readonly id: string }
  | { readonly operation: "revoke"; readonly id: string };

export class Recording extends Context.Service<
  Recording,
  { readonly events: Effect.Effect<ReadonlyArray<Event>> }
>()("@patchy/companies/InviteMail/Recording") {}

export const layerRecording = Layer.effectContext(
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<Event>>([]);
    const create = Effect.fn("InviteMail.recordCreate")(function* (email: string) {
      const id = newInternalId("clerk_inv");
      yield* Ref.update(events, (current): ReadonlyArray<Event> => [
        ...current,
        { operation: "create", email, id }
      ]);
      return id;
    });
    const revoke = Effect.fn("InviteMail.recordRevoke")((id: string) =>
      Ref.update(events, (current): ReadonlyArray<Event> => [
        ...current,
        { operation: "revoke", id }
      ])
    );
    return Context.make(InviteMail, InviteMail.of({ create, revoke })).pipe(
      Context.add(Recording, Recording.of({ events: Ref.get(events) }))
    );
  })
);

export const layerFailing = Layer.succeed(
  InviteMail,
  InviteMail.of({
    create: () => Effect.fail(new InviteMailError({ operation: "create" })),
    revoke: (id) => Effect.fail(new InviteMailError({ operation: "revoke", invitationId: id }))
  })
);
