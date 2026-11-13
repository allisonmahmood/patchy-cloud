// Owns the list that registers every portal surface's routes. Each surface's module owns its own
// routes, handlers and renderers; what two surfaces share lives in `shared/`, never in each other.
import * as Layer from "effect/Layer";
import * as AllPatchesPages from "./AllPatchesPages.js";
import * as Assets from "./Assets.js";
import * as FeedbackPages from "./FeedbackPages.js";
import * as HomePages from "./HomePages.js";
import * as PinPages from "./PinPages.js";
import * as PatchPages from "./PatchPages.js";
import * as SharePages from "./SharePages.js";
import type { Routes } from "./shared/handlers.js";
import * as SwitcherList from "./SwitcherList.js";
import * as UserLifecyclePage from "./UserLifecyclePage.js";
import * as WhatsNewPages from "./WhatsNewPages.js";

/** Home at `/`, which the server registers itself beside the signed-out door and the catch-all. */
export { navigation } from "./PinPages.js";
export { index } from "./HomePages.js";
export { errors } from "./shared/handlers.js";

export const layer: Routes = Layer.mergeAll(
  Assets.layer,
  PinPages.layer,
  HomePages.layer,
  AllPatchesPages.layer,
  PatchPages.layer,
  SharePages.layer({
    home: HomePages.page,
    allPatches: AllPatchesPages.page,
    card: PatchPages.render
  }),
  UserLifecyclePage.layer,
  WhatsNewPages.layer,
  FeedbackPages.layer,
  SwitcherList.layer
);
