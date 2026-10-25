/**
 * The `patchy` executable. The installed CLI runs on whichever Node is current,
 * so this refuses one older than the package's `engines` floor before loading
 * the CLI, whose bundle would otherwise fail there with a stack trace. It
 * imports nothing statically, so an old Node gets this far.
 */
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 22)) {
  const error = `Patchy needs Node.js 22.22.0 or newer; this is ${process.versions.node}. Switch to a newer Node with your version manager, or install the current Node.js LTS from https://nodejs.org.`;
  process.stderr.write(
    `${process.argv.includes("--json") ? JSON.stringify({ ok: false, error, kind: "local" }) : error}\n`
  );
  process.exitCode = 1;
} else {
  void import("./index.js");
}
