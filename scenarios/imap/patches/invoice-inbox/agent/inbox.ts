// Tools for people's agents, used through Patchy MCP: the page's own reads and its import, as the
// person.
export { overview as readInbox, search as searchInbox } from "../server/desk.js";
export { importFolder as importAttachments } from "../server/importer.js";
export { savedFiles as savedAttachments } from "../server/saved.js";
