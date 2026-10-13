/**
 * What PostHog discovery keeps about a project: its event definitions and its event and person
 * property definitions, never event rows. Types are hints for an agent writing HogQL; queries are
 * never refused for naming something outside the snapshot.
 */
import * as Schema from "effect/Schema";
import { registry } from "@patchy/limits/registry";

const Description = Schema.String.check(
  Schema.isMaxLength(registry["posthog.discovery.description"].default)
);

export const PostHogEvent = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Description)
});

export const PostHogProperty = Schema.Struct({
  name: Schema.String,
  /** PostHog's own property type, such as `String`, `Numeric`, `Boolean` or `DateTime`. */
  type: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64))),
  description: Schema.optionalKey(Description)
});

export const PostHogSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  events: Schema.Array(PostHogEvent),
  eventProperties: Schema.Array(PostHogProperty),
  personProperties: Schema.Array(PostHogProperty)
}).check(
  Schema.makeFilter(
    (snapshot) =>
      snapshot.events.length + snapshot.eventProperties.length + snapshot.personProperties.length <=
        registry["posthog.discovery.entries"].default ||
      `A PostHog snapshot keeps at most ${registry["posthog.discovery.entries"].default} definitions.`
  )
);
export type PostHogSnapshot = typeof PostHogSnapshot.Type;
