import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Stops `next dev` writing an AGENTS.md of its own here; the repo's agent docs live at its root.
  agentRules: false,
  // Next.js otherwise asks the npm registry, on `dev` and `build`, whether its own version has a
  // security advisory, and stops an agent's command once to say so. A build does the same thing
  // whoever runs it and calls nothing outside; dependency review already watches advisories.
  experimental: { agentUpgrade: false },
  async redirects() {
    return [{ source: "/", destination: "/docs", permanent: false }];
  },
  // A docs page's URL answers HTML or Markdown by `Accept` (`proxy.ts`), so every answer under
  // it asks for `Vary: Accept`. A self-hosted Next.js keeps it on the Markdown and replaces it
  // on prerendered HTML, which is why `proxy.ts` also makes both answers `no-store`.
  async headers() {
    return [{ source: "/docs/:path*", headers: [{ key: "Vary", value: "Accept" }] }];
  },
  // Every page's Markdown twin is its URL plus `.md`, the index's included.
  async rewrites() {
    return [
      { source: "/docs.md", destination: "/llms.mdx/docs.md" },
      { source: "/docs/:path*.md", destination: "/llms.mdx/docs/:path*.md" }
    ];
  }
};

export default withMDX(config);
