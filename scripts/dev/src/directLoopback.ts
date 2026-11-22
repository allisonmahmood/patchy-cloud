/**
 * Proxy settings that keep loopback direct. Bun's fetch sends even a loopback request through
 * `HTTP_PROXY` (or one a `.env` in its working directory names) unless `NO_PROXY` exempts it, and
 * the lowercase name wins over the uppercase one, so both are set. The dev runner gives these to
 * the server it starts, the measurement scripts to themselves and the Bun test lane to its
 * workers: a model call's input and its invented key reach the fake on loopback, never a proxy.
 */
export const directLoopback = {
  NO_PROXY: "127.0.0.1,localhost,::1",
  no_proxy: "127.0.0.1,localhost,::1"
} as const;
