// Disposable runner for a pinned, reviewed community module. Raw logs never leave this process.
class UnsupportedContext extends Error {}
process.once("message", async ({ modulePath, exportName, invocation }) => {
  let reply;
  try {
    const piece = require(modulePath)[exportName];
    const actions = piece.actions();
    if (!invocation)
      reply = { ok: true, value: { authType: piece.auth.type, actions: Object.keys(actions) } };
    else {
      const context = new Proxy(
        Object.freeze({ auth: invocation.auth, propsValue: invocation.propsValue }),
        {
          get(target, key) {
            if (!Object.hasOwn(target, key)) throw new UnsupportedContext();
            return Reflect.get(target, key);
          }
        }
      );
      const value = await actions[invocation.name].run(context);
      if (Buffer.byteLength(JSON.stringify(value)) > 8_000_000) throw new Error("Result too large");
      reply = { ok: true, value };
    }
  } catch (error) {
    reply = {
      ok: false,
      code: error instanceof UnsupportedContext ? "unsupported_context" : "module_action_failed"
    };
  }
  process.send(reply, () => process.exit(0));
});
