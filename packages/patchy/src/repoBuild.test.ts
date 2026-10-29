import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { Manifest } from "@patchy/api";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { validateRepoBundle } from "./repoBuild.js";
import { MANIFEST_VERSION, RELEASE } from "./release.js";

const manifest: typeof Manifest.Type = {
  manifestVersion: MANIFEST_VERSION,
  release: RELEASE,
  tier: 1,
  tables: {},
  files: {},
  uses: {}
};
const page = (body: string) =>
  `<!doctype html><html><head><title>Ok</title></head><body><p>hi</p>${body}</body></html>`;
/** Validate a built page from an empty repo, as publish and watched dev do after Vite. */
const validate = (html: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-bundle-" }).pipe(Effect.orDie);
    return yield* validateRepoBundle(cwd, manifest, html);
  }).pipe(Effect.scoped);
const refusal = (html: string) => Effect.flip(validate(html));

it.layer(NodeServices.layer)("validateRepoBundle", (it) => {
  it.effect("accepts navigation and embedded fonts but refuses unbundled resources", () =>
    Effect.gen(function* () {
      yield* validate(
        page(
          '<nav><a href="https://example.com/case-study">Case study</a><a href="/reports">All reports</a><a href="#work">Back to work</a></nav>' +
            '<map name="reports"><area shape="default" href="/reports" alt="All reports"></map>'
        )
      );
      yield* validate(
        page(
          '<style>@font-face { font-family: "Inter"; src: url("data:font/woff2;base64,d09GMgAB") format("woff2"); }</style>'
        )
      );
      assert.include(
        (yield* refusal(page('<img src="https://example.com/image.png" alt="Remote">'))).message,
        "is not self-contained"
      );
    })
  );

  it.effect("publishes harmless CSS strings and embedded image candidates", () =>
    validate(
      page(
        '<style>body::after { content: "@import url(foo) /* literal text */"; }</style>' +
          String.raw`<div style='--label: "@import url(foo)"; background-image: image-set("data:image/png;base64,AA==" 1x type("image/png")); mask-image: -webkit-image-set("\23 icon" 1x); filter: url(#icon)'></div>`
      )
    )
  );

  it.effect("refuses document-local blob assets and external CSS resources", () =>
    Effect.gen(function* () {
      for (const [asset, dependency] of [
        ['<img src="blob:https://example.test/temporary">', "<img> src is not embedded"],
        [
          '<object data="blob:https://example.test/temporary"></object>',
          "<object> data is not embedded"
        ],
        [
          `<iframe srcdoc="&lt;img src='blob:https://example.test/temporary'&gt;"></iframe>`,
          "<img> src is not embedded"
        ],
        [
          '<style>body { background-image: url("blob:https://example.test/temporary"); }</style>',
          "<style>: external CSS url()"
        ],
        [
          `<div style='background-image: image-set("https://example.test/pixel.png" 1x)'></div>`,
          "<div> style: external CSS image-set()"
        ],
        [
          `<div style='background-image: -webkit-image-set("blob:https://example.test/pixel" 1x)'></div>`,
          "<div> style: external CSS image-set()"
        ],
        [
          String.raw`<div style='background-image: image\2d set("\68 ttps://example.test/pixel.png" 1x)'></div>`,
          "<div> style: external CSS image-set()"
        ],
        [
          String.raw`<div style='background-image: \75rl("\62 lob:https://example.test/pixel")'></div>`,
          "<div> style: external CSS url()"
        ],
        [
          String.raw`<style>@\69mport "https://example.test/external.css";</style>`,
          "<style>: CSS @import"
        ]
      ] as const)
        assert.include((yield* refusal(page(asset))).message, `\n- ${dependency}`);
    })
  );

  it.effect("refuses CSS it cannot parse rather than hide a dependency behind it", () =>
    Effect.gen(function* () {
      const error = yield* refusal(
        page(
          `<div style='color: red; broken; background-image: image-set("https://example.test/pixel.png" 1x)'></div>`
        )
      );
      assert.include(error.message, "Could not inspect the HTML bundle.");
    })
  );

  it.effect("reports too_large with the cap and the offending resource", () =>
    Effect.gen(function* () {
      const cap = 10 * 1024 * 1024;
      const image = `data:image/png;base64,${"A".repeat(cap)}`;
      const error = yield* refusal(page(`<img src="${image}">`));
      assert.strictEqual(error.code, "too_large");
      assert.include(error.message, `maximum is ${cap} bytes`);
      assert.include(error.message, `<img> src: ${Buffer.byteLength(image)} bytes`);
    })
  );

  for (const folder of ["server", "agent"])
    it.effect(`infers ${folder} code from a directory, not a same-named regular file`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-bundle-" });
        const source = path.join(cwd, folder);
        yield* fs.writeFileString(source, "Documentation, not a server bundle.");
        yield* validateRepoBundle(cwd, manifest, page(""));
        yield* fs.remove(source);
        yield* fs.makeDirectory(source);
        const error = yield* Effect.flip(validateRepoBundle(cwd, manifest, page("")));
        assert.deepInclude(error, {
          code: "tier_mismatch",
          message: `${folder}/ requires tier 2. Change the tier and run \`patchy refresh\`, or remove ${folder}/.`
        });
      }).pipe(Effect.scoped)
    );
});
