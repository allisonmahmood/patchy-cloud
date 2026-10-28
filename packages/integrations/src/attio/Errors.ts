/**
 * Attio's runtime refusals with their own details. Each names the object or list, the attribute and
 * the reason; none carries a value patch code supplied or anything Attio answered.
 */
import { registry } from "@patchy/limits/registry";
import * as Schema from "effect/Schema";
import { scopeName } from "./Source.js";

const Name = Schema.String.check(Schema.isMaxLength(256));
/** The object or list a call was on, by slug. */
const where = {
  object: Schema.optionalKey(Name),
  list: Schema.optionalKey(Name)
};
const on = (error: { readonly object?: string; readonly list?: string }) =>
  error.object !== undefined
    ? ` on object ${error.object}`
    : error.list !== undefined
      ? ` on list ${error.list}`
      : "";
const at = (attribute: string | undefined) => (attribute === undefined ? "" : ` ${attribute}`);

/**
 * What the snapshot says isn't what Attio has now, or what Attio answered doesn't read. Lasts
 * until an admin refreshes the connection and the patch runs `patchy refresh`, except `value`.
 *
 * - `missing`, `archived`, `renamed` (to `renamedTo`): the attribute is gone under its name.
 * - `type`, `multiselect`: it now holds another type, or changed between one value and many.
 * - `targets`: a record reference no longer allows a snapshot target.
 * - `target`: a reference names an object the snapshot doesn't know by that name.
 * - `parent`: an entry is on a record of an object the list didn't have.
 * - `value`: a value didn't read as its type.
 */
export const shapeReasons = [
  "missing",
  "archived",
  "renamed",
  "type",
  "multiselect",
  "targets",
  "target",
  "parent",
  "value"
] as const;
export class ShapeMismatch extends Schema.TaggedError<ShapeMismatch>()("AttioShapeMismatch", {
  ...where,
  attribute: Schema.optionalKey(Name),
  reason: Schema.Literals(shapeReasons),
  renamedTo: Schema.optionalKey(Name)
}) {
  readonly code = "shape_mismatch" as const;
  readonly status = 400;
  override get message() {
    const what = `Attio's attribute${at(this.attribute)}${on(this)}`;
    switch (this.reason) {
      case "missing":
        return `${what} is gone. Ask an administrator to refresh the connection, then run \`patchy refresh\`.`;
      case "archived":
        return `${what} was archived. Ask an administrator to refresh the connection, then run \`patchy refresh\`.`;
      case "renamed":
        return `${what} was renamed to ${this.renamedTo ?? "another slug"}. Ask an administrator to refresh the connection, then run \`patchy refresh\`.`;
      case "type":
        return `${what} now holds another type. Ask an administrator to refresh the connection, then run \`patchy refresh\`.`;
      case "multiselect":
        return `${what} changed between one value and many. Ask an administrator to refresh the connection, then run \`patchy refresh\`.`;
      case "targets":
      case "target":
        return `${what} references an object the snapshot doesn't know by that name. Ask an administrator to refresh the connection, then run \`patchy refresh\`.`;
      case "parent":
        return `An entry${on(this)} is on a record of an object the snapshot's list doesn't have. Ask an administrator to refresh the connection, then run \`patchy refresh\`.`;
      case "value":
        return `${what} answered a value Patchy doesn't read.`;
    }
  }
  get details() {
    return {
      ...(this.object === undefined ? {} : { object: this.object }),
      ...(this.list === undefined ? {} : { list: this.list }),
      ...(this.attribute === undefined ? {} : { attribute: this.attribute }),
      reason: this.reason,
      ...(this.renamedTo === undefined ? {} : { renamedTo: this.renamedTo })
    };
  }
}

/**
 * Arguments Patchy refuses before Attio sees anything, or that Attio refused as written.
 *
 * - `unknown`: no such attribute in the snapshot.
 * - `unsupported`: the attribute's type doesn't take the operator.
 * - `value`: a value of the wrong kind for the type.
 * - `timestamp`: a timestamp needs a full ISO time, not a date alone.
 * - `bounds`: a range needs one lower and one upper bound at most, and at least one.
 * - `option`: Attio has no active option or status by that title.
 * - `target`: not one of the attribute's target objects, or a bare id where it has several.
 * - `parent`: not one of the list's parent objects, or a bare id where it has several.
 * - `attio`: Attio refused a value as written.
 */
export const requestReasons = [
  "unknown",
  "unsupported",
  "value",
  "timestamp",
  "bounds",
  "option",
  "target",
  "parent",
  "attio"
] as const;
export const operators = ["eq", "contains", "range", "orderBy", "parent"] as const;
export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()("AttioInvalidRequest", {
  ...where,
  attribute: Schema.optionalKey(Name),
  operator: Schema.optionalKey(Schema.Literals(operators)),
  reason: Schema.Literals(requestReasons)
}) {
  readonly code = "invalid_request" as const;
  readonly status = 400;
  override get message() {
    const what = `${this.operator ?? "The filter"}${at(this.attribute)}${on(this)}`;
    switch (this.reason) {
      case "unknown":
        return `${what}: the snapshot has no attribute by that slug. Read the connection's context for its attributes.`;
      case "unsupported":
        return `${what}: this attribute's type doesn't take ${this.operator === undefined ? "it" : this.operator}.`;
      case "value":
        return `${what}: a value isn't of this attribute's kind.`;
      case "timestamp":
        return `${what}: a timestamp needs a full ISO time, such as 2026-01-01T00:00:00Z, not a date alone.`;
      case "bounds":
        return `${what}: give at least one of gt or gte and lt or lte, and not both of a pair.`;
      case "option":
        return `${what}: Attio has no active option by that title. Titles are exact and case-sensitive; the context lists the known ones.`;
      case "target":
        return `${what}: name a record as { object, id } with one of the attribute's target objects.`;
      case "parent":
        return `${what}: name the parent as { object, id } with one of the list's parent objects.`;
      case "attio":
        return `${what}: Attio refused a value as written.`;
    }
  }
  get details() {
    return {
      ...(this.object === undefined ? {} : { object: this.object }),
      ...(this.list === undefined ? {} : { list: this.list }),
      ...(this.attribute === undefined ? {} : { attribute: this.attribute }),
      ...(this.operator === undefined ? {} : { operator: this.operator }),
      reason: this.reason
    };
  }
}

/** Patchy built a request Attio refused as malformed: Patchy's defect, never the patch's. */
export class InvalidQuery extends Schema.TaggedError<InvalidQuery>()("AttioInvalidQuery", {
  ...where,
  /** Attio's code for the refusal, such as `invalid_filter_operator`. */
  reason: Schema.String.check(Schema.isMaxLength(64))
}) {
  readonly code = "invalid_query" as const;
  readonly status = 400;
  override get message() {
    return `Attio refused the request Patchy built${on(this)} (${this.reason}). This is Patchy's fault: please report it.`;
  }
  get details() {
    return {
      ...(this.object === undefined ? {} : { object: this.object }),
      ...(this.list === undefined ? {} : { list: this.list }),
      reason: this.reason
    };
  }
}

/** The object or list is gone under its name, or the workspace turned a standard object off. */
export class NotFound extends Schema.TaggedError<NotFound>()("AttioNotFound", where) {
  readonly code = "not_found" as const;
  readonly status = 404;
  override get message() {
    return `Attio has no ${this.object === undefined ? `list ${this.list ?? ""}` : `object ${this.object}`} by that slug now. Ask an administrator to refresh the connection, then run \`patchy refresh\`.`;
  }
  get details(): Readonly<Record<string, string>> {
    return this.object === undefined ? { list: this.list ?? "" } : { object: this.object };
  }
}

/**
 * Attio refused the connection's key a read: it lacks the scope, named from Patchy's own table of
 * what each read needs, since Attio names scopes only in prose.
 */
export class Denied extends Schema.TaggedError<Denied>()("AttioDenied", {
  requires: Schema.String.check(Schema.isMaxLength(128))
}) {
  readonly code = "access_denied" as const;
  readonly status = 403;
  override get message() {
    return `Attio refused: this connection's key needs Read on ${scopeName(this.requires)}. Ask a company administrator to fix the key's scopes in Attio, or replace it, at /company/connections.`;
  }
  get details() {
    return { scope: this.requires };
  }
}

export class InvalidCursor extends Schema.TaggedError<InvalidCursor>()("AttioInvalidCursor", {}) {
  readonly code = "invalid_cursor" as const;
  readonly status = 400;
  override get message() {
    return "This cursor is from another call: it must come from the same object or list, revision, filters, parent and order.";
  }
}

/** Attio's answer, raw or decoded, is larger than Patchy reads in one call. */
export class TooLarge extends Schema.TaggedError<TooLarge>()("AttioTooLarge", {
  limitId: Schema.Literals(["attio.call.bytes", "runtime.result.bytes"]),
  /** What to change: a smaller `limit`, fewer `ids`, or nothing for one record or the members. */
  advice: Schema.Literals(["limit", "ids", "none"])
}) {
  readonly code = "too_large" as const;
  readonly status = 413;
  get maxBytes() {
    return registry[this.limitId].default;
  }
  override get message() {
    const read = `Attio's answer is larger than the ${this.maxBytes / 1024 ** 2} MiB Patchy reads in one call`;
    return this.advice === "limit"
      ? `${read}. Ask for a smaller limit: wide objects page smaller.`
      : this.advice === "ids"
        ? `${read}. Ask for fewer ids at once.`
        : `${read}, and this one answer can't be made smaller.`;
  }
  get details() {
    return { maxBytes: this.maxBytes };
  }
}

/**
 * An attribute asked for empty answered a value: an option, target or actor type arrived between
 * the call's check and its query. Nothing is returned; the same call again reads it right.
 */
export class Changed extends Schema.TaggedError<Changed>()("AttioChanged", {
  ...where,
  attribute: Name
}) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  override get message() {
    return `Attio's attribute ${this.attribute}${on(this)} changed while Patchy read it. Try again.`;
  }
}

/** Attio is merging this record into another; try shortly. */
export class Merging extends Schema.TaggedError<Merging>()("AttioMerging", where) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  override get message() {
    return "Attio is merging this record right now. Try again shortly.";
  }
}
