import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

// Built-in search over the pages, answered by this app; no outside service.
export const { GET } = createFromSource(source);
