import { createClerkClient } from "@clerk/backend";
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

const Origin = Schema.URLFromString.check(
  Schema.makeFilter(
    (url) =>
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
  )
);

export class InviteMail extends Context.Service<
  InviteMail,
  {
    readonly create: (email: string) => Effect.Effect<string, InviteMailError>;
    readonly revoke: (id: string) => Effect.Effect<void, InviteMailError>;
  }
>()("@patchy/companies/InviteMail") {}

export const make = Effect.gen(function* () {
  const publicUrl = yield* Config.schema(Origin, "PATCHY_PUBLIC_BASE_URL");
  const secretKey = yield* Config.schema(
    Schema.Redacted(Schema.NonEmptyString),
    "CLERK_SECRET_KEY"
  );
  const client = createClerkClient({
    secretKey: Redacted.value(secretKey),
    telemetry: { disabled: true }
  });
  const redirectUrl = new URL("/join", publicUrl).href;
  const create = Effect.fn("InviteMail.create")(function* (email: string) {
    const invitation = yield* Effect.tryPromise({
      try: () =>
        client.invitations.createInvitation({
          emailAddress: email,
          ignoreExisting: true,
          redirectUrl
        }),
      catch: (cause) => new InviteMailError({ operation: "create", cause })
    });
    return invitation.id;
  });
  const revoke = Effect.fn("InviteMail.revoke")((id: string) =>
    Effect.tryPromise({
      try: () => client.invitations.revokeInvitation(id),
      catch: (cause) => new InviteMailError({ operation: "revoke", invitationId: id, cause })
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
