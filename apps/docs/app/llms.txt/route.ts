import { docsLlms } from "@/lib/source";

export const revalidate = false;

// Every page with its description, linking each page's `.md` twin.
export async function GET() {
  return (await docsLlms.serve("/llms.txt"))!;
}
