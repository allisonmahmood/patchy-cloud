import { fontFaces } from "../fonts.js";
import { appShell } from "./app-shell.js";
import { base } from "./base.js";
import { buttons } from "./buttons.js";
import { changelog } from "./changelog.js";
import { checklist } from "./checklist.js";
import { containers } from "./containers.js";
import { detail } from "./detail.js";
import { dialogs } from "./dialogs.js";
import { disclosures } from "./disclosures.js";
import { doorParts } from "./door-parts.js";
import { doors } from "./doors.js";
import { fieldRows } from "./field-rows.js";
import { fields } from "./fields.js";
import { flowParts } from "./flow-parts.js";
import { marks } from "./marks.js";
import { menus } from "./menus.js";
import { navigation } from "./navigation.js";
import { notices } from "./notices.js";
import { pairs } from "./pairs.js";
import { rowsFlush } from "./rows-flush.js";
import { status } from "./status.js";
import { steps } from "./steps.js";
import { switcher } from "./switcher.js";
import { templates } from "./templates.js";
import { tableCells } from "./table-cells.js";
import { tables } from "./tables.js";
import { tiles } from "./tiles.js";
import { tokens } from "./tokens.js";
import { type } from "./type.js";
import { usual } from "./usual.js";
import { visibility } from "./visibility.js";
import { wideTables } from "./wide-tables.js";

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
  fieldRows,
  status,
  notices,
  containers,
  pairs,
  rowsFlush,
  tables,
  tableCells,
  wideTables,
  navigation,
  menus,
  dialogs,
  steps,
  tiles,
  flowParts,
  appShell,
  doors,
  doorParts,
  templates,
  changelog,
  switcher,
  usual,
  visibility,
  detail,
  checklist,
  disclosures
} as const;

export type ChunkName = keyof typeof chunks;

/** Every first-party page's styles; a running patch's shell has `servedStyles` instead. */
export const appStyles = Object.values(chunks).join("");
