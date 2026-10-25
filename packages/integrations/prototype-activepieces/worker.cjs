// Disposable runner for a pinned, reviewed community module. Raw logs never leave this process.
// pieces-common tries to set NODE_TLS_REJECT_UNAUTHORIZED=0. Keep certificate checks on.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
Object.defineProperty(process, "env", {
  value: new Proxy(process.env, {
    set(target, key, value) {
      if (key === "NODE_TLS_REJECT_UNAUTHORIZED") return true;
      return Reflect.set(target, key, value);
    },
    deleteProperty(target, key) {
      return key === "NODE_TLS_REJECT_UNAUTHORIZED" ? false : Reflect.deleteProperty(target, key);
    }
  }),
  writable: false,
  configurable: false
});
class UnsupportedContext extends Error {}
process.once("message", async ({ modulePath, exportName, authType, invocation }) => {
  let reply;
  try {
    const piece = require(modulePath)[exportName];
    const actions = piece.actions();
    const choices = Array.isArray(piece.auth) ? piece.auth : [piece.auth];
    const auth = authType
      ? choices.find((auth) => auth.type === authType)
      : choices.length === 1
        ? choices[0]
        : undefined;
    if (!auth) throw new Error("Explicit authentication selection required");
    if (!invocation)
      reply = { ok: true, value: { authType: auth.type, actions: Object.keys(actions) } };
    else if (invocation.kind === "validate") {
      if (typeof auth.validate !== "function") throw new Error("No auth validator");
      // Validators take the credential properties; actions take the piece's runtime auth shape.
      const result = await auth.validate({ auth: invocation.auth });
      reply = { ok: true, value: result.valid === true };
    } else {
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
