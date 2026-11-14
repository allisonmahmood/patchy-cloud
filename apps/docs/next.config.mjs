import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Stops `next dev` writing its own AGENTS.md here; the repo's agent docs live at its root.
  agentRules: false,
  async redirects() {
    return [{ source: "/", destination: "/docs", permanent: false }];
  }
};

export default withMDX(config);
