import { field, fieldRow, input, secretInput, select } from "@patchy/core";
import type * as View from "./ConnectionsView.js";

/**
 * The fields an integration asks an admin for, drawn the same way wherever they're asked: on its
 * connect page and on Replace key, Change project, Point elsewhere and Change access. An
 * integration says what a field is; these draw it with core's field family, so a refusal at it
 * reads under it and marks it, and nothing secret is ever written back.
 */

/** What a form posted, by field name; a page echoes only what isn't secret. */
export type Submitted = Readonly<Record<string, string | undefined>>;

interface Common {
  /** The form field's name, which the integration's `credentials` reads. */
  readonly name: string;
  /** The field a refusal names to sit under it. */
  readonly field: View.Field;
  readonly label: string;
  /** Only where the field can't be filled in correctly without it. */
  readonly hint?: string;
  /** Unique on the page; `connection-<name>` unless given. */
  readonly id?: string;
}

/** One field, by what it holds. Secrets are masked and never echoed; text keeps what was typed. */
export type Spec =
  | (Common & {
      readonly kind: "secret";
      readonly placeholder?: string;
      readonly autocomplete?: string;
      readonly maxlength?: number;
    })
  | (Common & {
      readonly kind: "text";
      readonly placeholder?: string;
      readonly maxlength?: number;
      readonly pattern?: string;
      readonly inputmode?: "text" | "numeric";
      readonly mono?: boolean;
      /** Answer width, for an answer of known length; full width otherwise. */
      readonly width?: "xs" | "sm" | "md";
    })
  | (Common & {
      readonly kind: "select";
      readonly choices: ReadonlyArray<{ readonly value: string; readonly label: string }>;
      /** The choice before anything was submitted. */
      readonly initial?: string;
      readonly width?: "xs" | "sm" | "md";
    });

/** A refusal as one line: what's wrong, how to fix it, then the code agents and support quote. */
export const refusalText = (refusal: View.Notice) => {
  const title = refusal.title === undefined ? "" : refusal.title.replace(/[.!?]?$/, ". ");
  return `${title}${refusal.message}${refusal.code === undefined ? "" : ` (${refusal.code})`}`;
};

/** The error a field shows: the refusal's words, when the refusal is about this field. */
export const errorAt = (name: View.Field, refusal: View.Notice | undefined) =>
  refusal?.field === name ? refusalText(refusal) : undefined;

/**
 * What a refused control that can't take focus itself, a native select or a choice group, sits
 * in, so focus lands on it and its error with or without script.
 */
export const focused = (html: string) => `<div tabindex="-1" autofocus>${html}</div>`;

/**
 * One field from its spec, with what was submitted where it isn't secret and the refusal at it.
 * A refused field takes focus, so the admin starts where the fix is; `focus` gives it to this
 * field when nothing was refused, as a dialog's first field takes it.
 */
export const render = (spec: Spec, submitted: Submitted, refusal?: View.Notice, focus = false) => {
  const error = errorAt(spec.field, refusal);
  const autofocus = error !== undefined || (focus && refusal === undefined);
  const drawn = field({
    id: spec.id ?? `connection-${spec.name}`,
    label: spec.label,
    ...(spec.hint === undefined ? {} : { hint: spec.hint }),
    ...(error === undefined ? {} : { error }),
    control: (aria) => {
      switch (spec.kind) {
        case "secret":
          return secretInput(aria, {
            name: spec.name,
            required: true,
            autocomplete: spec.autocomplete ?? "off",
            autofocus,
            ...(spec.placeholder === undefined ? {} : { placeholder: spec.placeholder }),
            ...(spec.maxlength === undefined ? {} : { maxlength: spec.maxlength })
          });
        case "text":
          return input(aria, {
            name: spec.name,
            value: submitted[spec.name] ?? "",
            required: true,
            autocomplete: "off",
            autofocus,
            ...(spec.placeholder === undefined ? {} : { placeholder: spec.placeholder }),
            ...(spec.maxlength === undefined ? {} : { maxlength: spec.maxlength }),
            ...(spec.pattern === undefined ? {} : { pattern: spec.pattern }),
            ...(spec.inputmode === undefined ? {} : { inputmode: spec.inputmode }),
            ...(spec.mono === undefined ? {} : { mono: spec.mono }),
            ...(spec.width === undefined ? {} : { width: spec.width })
          });
        case "select":
          return select(aria, {
            name: spec.name,
            choices: spec.choices,
            ...((submitted[spec.name] ?? spec.initial) === undefined
              ? {}
              : { value: submitted[spec.name] ?? spec.initial }),
            ...(spec.width === undefined ? {} : { width: spec.width })
          });
      }
    }
  });
  // A native select takes no autofocus of its own: a refused one sits in what does.
  return spec.kind === "select" && error !== undefined ? focused(drawn) : drawn;
};

/** Fields in order, a nested list being fields that share a row, such as a server and its port. */
export type Layout = ReadonlyArray<Spec | ReadonlyArray<Spec>>;

/** Every field of a layout, in order. */
export const flat = (layout: Layout): ReadonlyArray<Spec> =>
  layout.flatMap((item): ReadonlyArray<Spec> => (isRow(item) ? item : [item]));
const isRow = (item: Spec | ReadonlyArray<Spec>): item is ReadonlyArray<Spec> =>
  Array.isArray(item);

/**
 * Several fields in order, rows side by side; with `focus`, the first that can take it does, as
 * `render` says.
 */
export const renderAll = (
  layout: Layout,
  submitted: Submitted,
  refusal?: View.Notice,
  focus = false
) => {
  // A native select takes no autofocus, so a dialog starts on its first typed field; a field that
  // starts known, such as PostHog's region, comes before it.
  const first = flat(layout).find((spec) => spec.kind !== "select");
  const one = (spec: Spec) => render(spec, submitted, refusal, focus && spec === first);
  return layout.map((item) => (isRow(item) ? fieldRow(item.map(one)) : one(item))).join("");
};
