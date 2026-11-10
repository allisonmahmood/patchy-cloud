import { escapeAttribute, escapeHtml } from "../escape.js";
import { icon, type IconName } from "./icons.js";

/** `data-*` attributes, for a page's script. */
const dataAttributes = (data: Readonly<Record<string, string>> | undefined) =>
  Object.entries(data ?? {})
    .map(([key, value]) => ` data-${escapeAttribute(key)}="${escapeAttribute(value)}"`)
    .join("");

/** An attribute when it has a value, escaped; nothing when it doesn't. */
const attribute = (name: string, value: string | number | undefined) =>
  value === undefined ? "" : ` ${name}="${escapeAttribute(value)}"`;

const flag = (name: string, on: boolean | undefined) => (on === true ? ` ${name}` : "");

/**
 * A button's look. `primary` is the region's one main action; `secondary`, the default, is plain;
 * `quiet` has no frame; `danger` is the destructive tone and `danger-solid` the final destructive
 * step, such as Delete in a typed-name confirmation.
 */
export interface ButtonLook {
  readonly kind?: "primary" | "secondary" | "quiet" | "danger" | "danger-solid";
  /** `sm` for row actions and compact places. */
  readonly size?: "md" | "sm";
  readonly icon?: IconName;
  /** As wide as what holds it. */
  readonly block?: boolean;
  /** Names the action for assistive tech when the label alone doesn't, such as "Share Kudos". */
  readonly ariaLabel?: string;
  readonly autofocus?: boolean;
  readonly data?: Readonly<Record<string, string>>;
}

/** A button's classes from its look, with `extra` last; for core helpers that draw a button. */
export const buttonClass = ({ kind, size, block }: ButtonLook, extra = "") =>
  [
    "btn",
    kind === undefined || kind === "secondary" ? "" : `btn-${kind}`,
    size === "sm" ? "btn-sm" : "",
    block === true ? "btn-block" : "",
    extra
  ]
    .filter((part) => part !== "")
    .join(" ");

const buttonInner = (label: string, look: ButtonLook) =>
  `${look.icon === undefined ? "" : icon(look.icon)}${escapeHtml(label)}`;

const lookAttributes = (look: ButtonLook) =>
  `${attribute("aria-label", look.ariaLabel)}${flag("autofocus", look.autofocus)}${dataAttributes(look.data)}`;

/**
 * A button in a form. `pending` is the static "Testing…" state of a pressed button: the caller
 * gives the pending label, and the button says it can't be pressed again without changing size.
 */
export const button = (
  label: string,
  options: ButtonLook & {
    readonly type?: "submit" | "button";
    readonly name?: string;
    readonly value?: string;
    /** The id of the form it submits, when it sits outside it. */
    readonly form?: string;
    readonly pending?: boolean;
  } = {}
) =>
  `<button class="${buttonClass(options)}" type="${options.type ?? "submit"}"${attribute("name", options.name)}${attribute("value", options.value)}${attribute("form", options.form)}${options.pending === true ? ' aria-disabled="true"' : ""}${lookAttributes(options)}>${buttonInner(label, options)}</button>`;

/** A link drawn as a button, for an action that is a place: Open, Connect, Cancel. */
export const linkButton = (
  label: string,
  href: string,
  options: ButtonLook & { readonly newTab?: boolean } = {}
) =>
  `<a class="${buttonClass(options)}" href="${escapeAttribute(href)}"${options.newTab === true ? ' target="_blank" rel="noopener"' : ""}${lookAttributes(options)}>${buttonInner(label, options)}</a>`;

/** A square button holding one icon, named by `label`; a link when given `href`. */
export const iconButton = (
  label: string,
  name: IconName,
  options: {
    readonly href?: string;
    readonly size?: "sm" | "md";
    readonly popovertarget?: string;
  } = {}
) => {
  const className = `btn btn-icon${options.size === "md" ? " btn-md" : ""}`;
  return options.href === undefined
    ? `<button class="${className}" type="button"${attribute("popovertarget", options.popovertarget)} aria-label="${escapeAttribute(label)}">${icon(name)}</button>`
    : `<a class="${className}" href="${escapeAttribute(options.href)}" aria-label="${escapeAttribute(label)}">${icon(name)}</a>`;
};

/** What a field gives its control: the id its label names, what describes it, and whether it is refused. */
export interface FieldControl {
  readonly id: string;
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
}

/**
 * A labelled field: label, hint, control, error, in that order. The control is drawn from the
 * ids the field gives it, so the hint and error describe it (`aria-describedby`) and a refusal
 * marks it `aria-invalid`. `id` must be unique on the page.
 */
export const field = (spec: {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  /** The refusal for this field after a submit, in Patchy's words. */
  readonly error?: string;
  readonly optional?: boolean;
  readonly control: (aria: FieldControl) => string;
}) => {
  const hintId = `${spec.id}-hint`;
  const errorId = `${spec.id}-error`;
  const describedBy = [
    spec.hint === undefined ? undefined : hintId,
    spec.error === undefined ? undefined : errorId
  ]
    .filter((id) => id !== undefined)
    .join(" ");
  return `<div class="fieldset"><label class="field-label" for="${escapeAttribute(spec.id)}">${escapeHtml(spec.label)}${spec.optional === true ? ' <span class="field-optional">(optional)</span>' : ""}</label>${spec.hint === undefined ? "" : `<p class="field-hint" id="${escapeAttribute(hintId)}">${escapeHtml(spec.hint)}</p>`}${spec.control({ id: spec.id, describedBy: describedBy === "" ? undefined : describedBy, invalid: spec.error !== undefined })}${spec.error === undefined ? "" : `<p class="field-error" id="${escapeAttribute(errorId)}">${escapeHtml(spec.error)}</p>`}</div>`;
};

const controlAttributes = (aria: FieldControl) =>
  `id="${escapeAttribute(aria.id)}"${attribute("aria-describedby", aria.describedBy)}${aria.invalid ? ' aria-invalid="true"' : ""}`;

/** What an input carries besides its field's ids. */
export interface InputOptions {
  readonly name: string;
  readonly type?: "text" | "email" | "url" | "search" | "number" | "tel";
  readonly value?: string;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly autocomplete?: string;
  readonly maxlength?: number;
  readonly pattern?: string;
  readonly inputmode?: "text" | "email" | "url" | "numeric";
  /** For what is typed exactly: handles, keys, URLs. */
  readonly mono?: boolean;
  /** Answer width, for an answer of known length. */
  readonly width?: "xs" | "sm" | "md";
  readonly autofocus?: boolean;
  /** The id of a `<datalist>` of suggestions, such as the people a patch was shared with before. */
  readonly list?: string;
}

const inputAttributes = (options: InputOptions) =>
  `name="${escapeAttribute(options.name)}"${attribute("value", options.value)}${attribute("placeholder", options.placeholder)}${flag("required", options.required)}${attribute("autocomplete", options.autocomplete)}${attribute("maxlength", options.maxlength)}${attribute("pattern", options.pattern)}${attribute("inputmode", options.inputmode)}${attribute("list", options.list)}${flag("autofocus", options.autofocus)}`;

const fieldClass = (options: Pick<InputOptions, "mono" | "width">) =>
  `field${options.mono === true ? " field-mono" : ""}${options.width === undefined ? "" : ` field-w-${options.width}`}`;

/** A one-line input. */
export const input = (aria: FieldControl, options: InputOptions) =>
  `<input class="${fieldClass(options)}" type="${options.type ?? "text"}" ${controlAttributes(aria)} ${inputAttributes(options)}>`;

/** A multi-line input; `grow` starts one line tall and grows with what is typed. */
export const textarea = (
  aria: FieldControl,
  options: Omit<InputOptions, "type" | "pattern" | "inputmode" | "width"> & {
    readonly rows?: number;
    readonly grow?: boolean;
  }
) =>
  `<textarea class="field${options.grow === true ? " field-grow" : ""}${options.mono === true ? " field-mono" : ""}" ${controlAttributes(aria)} name="${escapeAttribute(options.name)}"${attribute("rows", options.rows)}${attribute("placeholder", options.placeholder)}${flag("required", options.required)}${attribute("maxlength", options.maxlength)}${attribute("autocomplete", options.autocomplete)}${flag("autofocus", options.autofocus)}>${escapeHtml(options.value ?? "")}</textarea>`;

/** A native select of `choices`, `value` chosen. */
export const select = (
  aria: FieldControl,
  options: {
    readonly name: string;
    readonly choices: ReadonlyArray<{ readonly value: string; readonly label: string }>;
    readonly value?: string;
    readonly width?: "xs" | "sm" | "md";
    readonly autofocus?: boolean;
  }
) =>
  `<select class="${fieldClass(options)}" ${controlAttributes(aria)} name="${escapeAttribute(options.name)}"${flag("autofocus", options.autofocus)}>${options.choices
    .map(
      (choice) =>
        `<option value="${escapeAttribute(choice.value)}"${choice.value === options.value ? " selected" : ""}>${escapeHtml(choice.label)}</option>`
    )
    .join("")}</select>`;

/**
 * An input with a fixed prefix fused before it, such as `attio/` before a handle. The prefix is a
 * second label, so pressing it focuses the input.
 */
export const prefixInput = (
  aria: FieldControl,
  options: InputOptions & { readonly prefix: string }
) =>
  `<div class="field field-group${options.width === undefined ? "" : ` field-w-${options.width}`}"><label class="field-prefix" for="${escapeAttribute(aria.id)}">${escapeHtml(options.prefix)}</label><input class="${options.mono === false ? "" : "field-mono"}" type="${options.type ?? "text"}" ${controlAttributes(aria)} ${inputAttributes(options)}></div>`;

/**
 * A secret, masked as it is typed. Its Show button waits hidden for the page's enhancer, which
 * reveals it and toggles the mask; without script the field stays masked.
 */
export const secretInput = (
  aria: FieldControl,
  options: Omit<InputOptions, "type" | "mono" | "inputmode">
) =>
  `<div class="secret"><input class="field" type="password" ${controlAttributes(aria)} ${inputAttributes(options)} spellcheck="false"><button class="btn btn-quiet btn-sm" type="button" data-show="${escapeAttribute(aria.id)}" aria-controls="${escapeAttribute(aria.id)}" aria-pressed="false" hidden>Show</button></div>`;

/** One checkbox or radio with its label beside it; `aria` is what its `choiceGroup` hands it. */
const choice =
  (kind: "checkbox" | "radio") =>
  (options: {
    readonly name: string;
    readonly value: string;
    readonly label: string;
    readonly checked?: boolean;
    readonly disabled?: boolean;
    readonly aria?: ChoiceAria;
  }) =>
    `<label class="field-choice"><input class="field-${kind}" type="${kind}" name="${escapeAttribute(options.name)}" value="${escapeAttribute(options.value)}"${flag("checked", options.checked)}${flag("disabled", options.disabled)}${attribute("aria-describedby", options.aria?.describedBy)}${options.aria?.invalid === true ? ' aria-invalid="true"' : ""}>${escapeHtml(options.label)}</label>`;

export const checkbox = choice("checkbox");
export const radio = choice("radio");

/** What a choice group gives its choices: what describes them, and whether the group is refused. */
export interface ChoiceAria {
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
}

/**
 * Choices of one group under a legend, with an optional hint and error in the field order. A
 * refused group is marked invalid, and so is each choice drawn from the `aria` it hands out.
 */
export const choiceGroup = (spec: {
  readonly id: string;
  readonly legend: string;
  readonly hint?: string;
  readonly error?: string;
  /** Trusted HTML, or drawn from the group's `aria`: `checkbox`, `radio` or `choiceCards` output. */
  readonly choices: string | ((aria: ChoiceAria) => string);
}) => {
  const hintId = `${spec.id}-hint`;
  const errorId = `${spec.id}-error`;
  const ids = [
    spec.hint === undefined ? undefined : hintId,
    spec.error === undefined ? undefined : errorId
  ]
    .filter((id) => id !== undefined)
    .join(" ");
  const aria: ChoiceAria = {
    describedBy: ids === "" ? undefined : ids,
    invalid: spec.error !== undefined
  };
  return `<fieldset class="fieldset" id="${escapeAttribute(spec.id)}"${attribute("aria-describedby", aria.describedBy)}${aria.invalid ? ' aria-invalid="true"' : ""}><legend class="field-label">${escapeHtml(spec.legend)}</legend>${spec.hint === undefined ? "" : `<p class="field-hint" id="${escapeAttribute(hintId)}">${escapeHtml(spec.hint)}</p>`}<div class="choice-row">${typeof spec.choices === "string" ? spec.choices : spec.choices(aria)}</div>${spec.error === undefined ? "" : `<p class="field-error" id="${escapeAttribute(errorId)}">${escapeHtml(spec.error)}</p>`}</fieldset>`;
};

/**
 * A switch: a one-button form whose press posts the other state. `fields` is trusted HTML,
 * usually hidden inputs naming what the press sets.
 */
export const switchForm = (spec: {
  readonly action: string;
  readonly label: string;
  readonly checked: boolean;
  readonly fields?: string;
}) =>
  `<form method="post" action="${escapeAttribute(spec.action)}">${spec.fields ?? ""}<button class="switch" type="submit" role="switch" aria-checked="${spec.checked}" aria-label="${escapeAttribute(spec.label)}"></button></form>`;
