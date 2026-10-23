// Test-only modules: none of these are real connectors or real provider calls.
exports.oauth = { auth: { type: "OAUTH2" }, actions: () => ({}) };
exports.needsStore = {
  auth: { type: "SECRET_TEXT" },
  actions: () => ({
    unsupported: { run: async (context) => context.store }
  })
};
