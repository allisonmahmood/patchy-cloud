/**
 * A refusal no field owns, such as an answer from a page shown to another account: the page's
 * focus starts on it, so it is read before anything else. `notice` is trusted HTML, usually
 * `notice` output. A refusal that belongs to a field is that field's error instead, and the field
 * takes the focus.
 */
export const refusal = (notice: string) =>
  `<div class="refusal" tabindex="-1" autofocus>${notice}</div>`;
