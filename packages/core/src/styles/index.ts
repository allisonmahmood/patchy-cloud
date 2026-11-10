import { fontFaces } from "../fonts.js";
import { appShell } from "./app-shell.js";
import { base } from "./base.js";
import { buttons } from "./buttons.js";
import { containers } from "./containers.js";
import { dialogs } from "./dialogs.js";
import { doors } from "./doors.js";
import { fields } from "./fields.js";
import { marks } from "./marks.js";
import { menus } from "./menus.js";
import { navigation } from "./navigation.js";
import { notices } from "./notices.js";
import { status } from "./status.js";
import { steps } from "./steps.js";
import { switcher } from "./switcher.js";
import { templates } from "./templates.js";
import { tables } from "./tables.js";
import { tiles } from "./tiles.js";
import { tokens } from "./tokens.js";
import { type } from "./type.js";
import { whatsNew } from "./whats-new.js";

/**
 * The app's stylesheet as named chunks, in cascade order: fonts and tokens, the document and type,
 * then one chunk per component family. A new family is a new file and one line here; a page never
 * adds CSS of its own.
 */
export const chunks = {
  fonts: fontFaces,
  tokens,
  base,
  type,
  marks,
  buttons,
  fields,
  status,
  notices,
  containers,
  tables,
  navigation,
  menus,
  dialogs,
  steps,
  tiles,
  appShell,
  doors,
  templates,
  whatsNew,
  switcher
} as const;

export type ChunkName = keyof typeof chunks;

/** Every first-party page's styles; a running patch's shell has `servedStyles` instead. */
export const appStyles = Object.values(chunks).join("");
