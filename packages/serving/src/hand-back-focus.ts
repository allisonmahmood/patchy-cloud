/// <reference lib="dom" />
// @effect-diagnostics globalTimers:off
// The served shell's own controls run in the browser, without an Effect runtime.

const nowhere = () => document.activeElement === null || document.activeElement === document.body;

/**
 * Hands focus back to the patch's frame when a shell control, such as the new-version bar, a
 * download card or the single-key shortcuts dialog, is redrawn or removed. Call it before the
 * change and call what it returns after. Focus goes back when it was on `control`, or, when the
 * person pressed one of the control's own buttons, nowhere: on the shell's body, as after a click
 * on a button that takes no focus. It never moves from somewhere else the person put it.
 */
export function handBackFocus(
  frame: HTMLIFrameElement,
  control: Element,
  { pressed }: { readonly pressed: boolean }
): () => void {
  const back = control.contains(document.activeElement) || (pressed && nowhere());
  return () => {
    if (!back) return;
    frame.focus();
    // Firefox won't hand a frame focus during the key event that pressed a shell button, Enter
    // on keydown or Space on keyup: the frame takes it once that is over, unless the person has
    // put focus somewhere of their own meanwhile.
    setTimeout(() => {
      if (nowhere()) frame.focus();
    });
  };
}
