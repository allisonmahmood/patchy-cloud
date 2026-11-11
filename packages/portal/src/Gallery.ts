import type * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import { pageResponse } from "@patchy/auth";
import { type GalleryPage, galleryPage, galleryPages, galleryPath, WhatsNew } from "@patchy/core";

/**
 * The `/~ui` gallery and its template pages, for development only: the server mounts these
 * behind the same gate as the persona picker, so a production server answers them with its 404.
 * They draw the app's frame for a sample person and need no session, so `pnpm dev shot` and a
 * signed-out browser see the same pages. The dialog's form posts back and is always refused, so
 * the refusal state and the way out of it can be tried.
 */
const viewer = {
  user: { id: "usr_gallery", name: "Ada Lovelace", email: "ada@example.com" },
  company: { id: "co_gallery", name: "Acme Co" },
  whatsNewSeen: WhatsNew.latestRelease,
  singleKeyShortcuts: true
};

export const layer: Layer.Layer<never, never, HttpRouter.HttpRouter> = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const render = (page: GalleryPage, refused = false) => {
      const content = galleryPage(page, refused);
      return pageResponse(
        content.door === true
          ? { title: content.title, heading: content.heading, body: content.body }
          : {
              title: `${content.title} – Gallery`,
              heading: content.heading,
              body: content.body,
              ...(refused ? { status: 422 } : {}),
              app: {
                viewer,
                section: "patches",
                ...(content.overlay === undefined ? {} : { overlay: content.overlay })
              }
            }
      );
    };
    for (const page of galleryPages)
      yield* router.add("GET", page === "" ? galleryPath : `${galleryPath}/${page}`, render(page));
    // The dialog's form always refuses, drawing the dialog again with its error, as a page does.
    yield* router.add("POST", `${galleryPath}/dialog`, render("dialog", true));
  })
);
