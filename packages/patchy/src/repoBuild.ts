import { Manifest } from "@patchy/api";
import { DEFAULT_MAX_HTML_BYTES, validateHtml } from "@patchy/core";
import * as CssTree from "css-tree";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as parse5 from "parse5";
import * as Api from "./Api.js";
import * as Instance from "./Instance.js";
import { LocalError, ReleaseMismatch } from "./CliError.js";
import { executeConfig, StaleGenerated } from "./executeConfig.js";
import { safePath } from "./ManagedProject.js";
import { checkRelease } from "./ReleaseCheck.js";
import { RELEASE } from "./release.js";
import { processResult } from "./processResult.js";

const decodePackage = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      devDependencies: Schema.Struct({ patchy: Schema.String })
    })
  )
);
const decodeRuntime = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String));
const decodeManifest = Schema.decodeUnknownSync(Manifest);
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(Manifest));
const isLocalError = Schema.is(LocalError);
const maxBundleBytes = 10 * 1024 * 1024;

const embedded = (value: string) => /^(?:data:|#)/i.test(value.trim());

/** Inventory built resources, including templates; core owns static HTML safety, not this check. */
const inspectBundle = (html: string, tier: number) => {
  const dependencies = new Set<string>();
  const contributors: Array<{ name: string; bytes: number }> = [];
  const css = (source: string, location: string, context: "stylesheet" | "declarationList") => {
    // CSSTree preserves escaped identifiers, but only a literal url name gets URL tokenization.
    // Normalize that token alone so quoted/unquoted embedded URLs keep their CSS semantics.
    let normalized = "";
    let copied = 0;
    if (source.includes("\\")) {
      CssTree.tokenize(source, (type, start, end) => {
        if (type !== CssTree.tokenTypes.Function) return;
        const name = source.slice(start, end - 1);
        if (!name.includes("\\") || CssTree.ident.decode(name).toLowerCase() !== "url") return;
        normalized += `${source.slice(copied, start)}url(`;
        copied = end;
      });
    }
    const ast = CssTree.parse(copied ? normalized + source.slice(copied) : source, {
      context,
      parseCustomProperty: true,
      onParseError(error) {
        throw error;
      }
    });
    CssTree.walk(ast, (node) => {
      // Unparsed syntax must never conceal a resource, including in custom properties.
      if (node.type === "Raw") dependencies.add(`${location}: unsupported CSS syntax`);
      if (node.type === "Atrule" && CssTree.ident.decode(node.name).toLowerCase() === "import")
        dependencies.add(`${location}: CSS @import`);
      if (node.type === "Url" && !embedded(node.value))
        dependencies.add(`${location}: external CSS url()`);
      if (node.type === "Function") {
        const name = CssTree.ident.decode(node.name).toLowerCase();
        if (name === "image-set" || name === "-webkit-image-set") {
          // Only direct strings are image candidates; type("image/png") is a descriptor.
          for (const child of node.children) {
            if (child.type === "String" && !embedded(child.value))
              dependencies.add(`${location}: external CSS image-set()`);
          }
        }
      }
    });
  };
  const srcset = (value: string) => {
    // URL tokens may contain commas (notably data URLs); descriptors end at the next comma.
    let rest = value.trimStart();
    while (rest) {
      const token = /^\S+/.exec(rest)?.[0] ?? "";
      if (!embedded(token.replace(/,+$/, ""))) return false;
      rest = rest.slice(token.length).trimStart();
      if (!token.endsWith(",")) {
        const comma = rest.indexOf(",");
        rest = comma < 0 ? "" : rest.slice(comma + 1).trimStart();
      }
    }
    return true;
  };
  const walk = (node: parse5.DefaultTreeAdapterMap["node"]) => {
    if ("tagName" in node) {
      const tag = node.tagName;
      for (const attr of node.attrs) {
        const name = attr.name;
        const location = `<${tag}> ${attr.prefix ? `${attr.prefix}:` : ""}${name}`;
        if (name === "srcdoc")
          walk(parse5.parseFragment(attr.value, { scriptingEnabled: tier > 0 }));
        const value = attr.value.trim();
        if (name === "style") css(value, location, "declarationList");
        if (name === "srcset" || name === "imagesrcset") {
          if (!srcset(value)) dependencies.add(`${location} is not embedded`);
        }
        if (
          name === "src" ||
          name === "poster" ||
          name === "background" ||
          (tag === "object" && name === "data")
        ) {
          if (tag === "script" || !embedded(value)) dependencies.add(`${location} is not embedded`);
        }
        if (name === "href") {
          const navigation = tag === "a" || tag === "area";
          if (tag === "link" || tag === "script" || (!navigation && !embedded(value)))
            dependencies.add(`${location} is unsupported`);
        }
        if (/^data:/i.test(value))
          contributors.push({ name: location, bytes: Buffer.byteLength(value) });
      }
      if (tag === "script" || tag === "style") {
        const text = node.childNodes.map((child) => ("value" in child ? child.value : "")).join("");
        contributors.push({ name: `inline <${tag}>`, bytes: Buffer.byteLength(text) });
        if (tag === "style") css(text, "<style>", "stylesheet");
      }
      if ("content" in node) walk(node.content);
    }
    if ("childNodes" in node) for (const child of node.childNodes) walk(child);
  };
  walk(parse5.parse(html, { scriptingEnabled: tier > 0 }));
  contributors.push({
    name: "HTML markup and text",
    bytes: Math.max(
      0,
      Buffer.byteLength(html) - contributors.reduce((total, entry) => total + entry.bytes, 0)
    )
  });
  return {
    dependencies: [...dependencies],
    contributors: contributors.sort((a, b) => b.bytes - a.bytes).slice(0, 5)
  };
};

/** New publish and dev sessions must agree with the instance before executing config. */
export const checkRepoRelease = Effect.fn("checkRepoRelease")(function* (
  cwd: string,
  token: Redacted.Redacted
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const instance = yield* Instance.Instance;
  const client = yield* Api.client(token);
  const release = yield* client
    .release()
    .pipe(Effect.catch((error) => Api.classify(error, "Could not read the instance release.")));
  const packageText = yield* fs.readFileString(path.join(cwd, "package.json")).pipe(
    Effect.mapError(
      (cause) =>
        new LocalError({
          message: "Run this command inside a patch repo created with `patchy init`.",
          cause
        })
    )
  );
  const pkg = yield* Effect.try({
    try: () => decodePackage(packageText),
    catch: (cause) =>
      new LocalError({
        message: "package.json must pin patchy as a devDependency. Run `patchy refresh`.",
        code: "release_mismatch",
        cause
      })
  });
  const tarball = new URL(release.package.tarball, `${instance.apiUrl}/`).href;
  const pin = pkg.devDependencies.patchy;
  if (pin !== tarball)
    return yield* new ReleaseMismatch({
      component: "pin",
      loaded: /patchy-([^/]+)\.tgz(?:[?#].*)?$/.exec(pin)?.[1] ?? pin,
      current: release.release
    });
  yield* checkRelease(release.release, { cli: RELEASE });
  const runtime = yield* processResult(cwd, process.execPath, [
    "--input-type=module",
    "--eval",
    'import { RELEASE } from "patchy/dev"; process.stdout.write(JSON.stringify(RELEASE));'
  ]);
  if (runtime.code !== 0)
    return yield* new LocalError({
      message: "Could not load the repo's installed Patchy runtime. Run `patchy refresh`.",
      code: "release_mismatch"
    });
  const loadedRuntime = yield* Effect.try({
    try: () => decodeRuntime(runtime.stdout),
    catch: (cause) =>
      new LocalError({
        message: "The installed Patchy runtime did not report its release. Run `patchy refresh`.",
        code: "release_mismatch",
        cause
      })
  });
  yield* checkRelease(release.release, { cli: RELEASE, runtime: loadedRuntime });
});

/** Recovery belongs to the caller and must finish before this starts any fresh work. */
export const prepareRepoPublish = Effect.fn("prepareRepoPublish")(function* (
  cwd: string,
  token: Redacted.Redacted
) {
  yield* checkRepoRelease(cwd, token);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifest = yield* Effect.tryPromise({
    try: async () => decodeManifest(await executeConfig(path.join(cwd, "patchy.config.ts"))),
    catch: (cause) =>
      new LocalError({
        message:
          cause instanceof StaleGenerated
            ? "declarations changed; run `patchy refresh`"
            : "Could not execute patchy.config.ts. Check the config and its imports.",
        code: cause instanceof StaleGenerated ? cause.code : "invalid_manifest",
        cause
      })
  });
  // Definitions can change without generation; only index.json owns declaration stamps.
  const destination = yield* Effect.tryPromise({
    try: () => safePath(cwd, "patchy/_generated/manifest.json"),
    catch: (cause) =>
      new LocalError({ message: "Could not resolve the managed manifest path.", cause })
  });
  yield* fs.writeFileString(destination, `${encodeManifest(manifest)}\n`).pipe(
    Effect.mapError(
      (cause) =>
        new LocalError({
          message: "Could not update patchy/_generated/manifest.json for the current config.",
          cause
        })
    )
  );
  const typecheck = yield* processResult(cwd, process.execPath, [
    path.join(cwd, "node_modules/typescript/bin/tsc"),
    "--noEmit"
  ]);
  if (typecheck.code !== 0)
    return yield* new LocalError({
      message:
        "Typecheck failed. Run `pnpm exec tsc --noEmit` and fix the errors before publishing.",
      cause: typecheck
    });
  const html = yield* Effect.scoped(
    Effect.gen(function* () {
      const output = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-publish-" });
      const build = yield* processResult(cwd, process.execPath, [
        path.join(cwd, "node_modules/vite/bin/vite.js"),
        "build",
        "--outDir",
        output,
        "--emptyOutDir"
      ]);
      if (build.code !== 0)
        return yield* new LocalError({
          message:
            "Vite build failed. Run `pnpm exec vite build` and fix the single-file build before publishing.",
          cause: build
        });
      const entries = yield* fs.readDirectory(output, { recursive: true });
      const files: string[] = [];
      for (const entry of entries) {
        const info = yield* fs.stat(path.join(output, entry));
        if (info.type !== "Directory") files.push(entry);
      }
      if (files.length !== 1 || files[0] !== "index.html")
        return yield* new LocalError({
          message: `Vite must emit only index.html; found ${files.length ? files.join(", ") : "no HTML output"}. Inline every asset with vite-plugin-singlefile; remove public files, sourcemaps and extra entrypoints.`
        });
      return yield* fs.readFileString(path.join(output, "index.html"));
    })
  ).pipe(
    Effect.mapError((cause) =>
      isLocalError(cause)
        ? cause
        : new LocalError({
            message: "Could not read the Vite build output.",
            cause
          })
    )
  );
  yield* validateRepoBundle(cwd, manifest, html);
  return { manifest, html };
});

/** Publish and watched dev builds enforce the same artifact and tier contract. */
export const validateRepoBundle = Effect.fn("validateRepoBundle")(function* (
  cwd: string,
  manifest: typeof Manifest.Type,
  html: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const inspection = yield* Effect.try({
    try: () => inspectBundle(html, manifest.tier),
    catch: (cause) =>
      new LocalError({
        message:
          "Could not inspect the HTML bundle. Use valid, supported CSS with embedded resources.",
        cause
      })
  });
  if (inspection.dependencies.length)
    return yield* new LocalError({
      message: `The HTML bundle is not self-contained or uses unsupported external dependencies:\n- ${inspection.dependencies.join("\n- ")}\nInline resources in the HTML; use Patchy integrations instead of external dependencies.`
    });
  const bytes = Buffer.byteLength(html, "utf8");
  const maxBytes = manifest.tier === 0 ? DEFAULT_MAX_HTML_BYTES : maxBundleBytes;
  if (bytes > maxBytes)
    return yield* new LocalError({
      message: `HTML bundle is ${bytes} bytes; maximum for tier ${manifest.tier} is ${maxBytes} bytes. Largest contributors:\n${inspection.contributors.map((entry) => `- ${entry.name}: ${entry.bytes} bytes`).join("\n")}\nReduce these resources before publishing.`,
      code: "too_large"
    });
  const server = yield* fs.stat(path.join(cwd, "server")).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound" ? Effect.succeed(false) : Effect.fail(cause)
    }),
    Effect.mapError(
      (cause) =>
        new LocalError({ message: "Could not inspect server/ for the evident tier.", cause })
    )
  );
  if (server || manifest.tier >= 2)
    return yield* new LocalError({
      message: server
        ? "server/ requires tier 2, which is not served yet. Remove server code before publishing."
        : "Tier 2 and above are not served yet.",
      code: "tier_mismatch"
    });
  if (manifest.tier === 0) {
    const validation = validateHtml(html, { maxBytes });
    if (!validation.ok)
      return yield* new LocalError({
        message: `Tier 0 HTML failed the static-page policy. Browser code requires tier 1 in patchy.config.ts:\n- ${validation.errors.join("\n- ")}`,
        code: "tier_mismatch"
      });
  }
});
