import { docsLlms } from "@/lib/source";

export const revalidate = false;

// index() is synchronous for a build-time source; the guide's `await` is for runtime sources.
export function GET() {
  return new Response(docsLlms.index());
}
