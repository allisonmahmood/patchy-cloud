import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { appName } from "./shared";

/** The nav every layout shares: Patchy's mark and name, linking to the docs' first page. */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <img src="/logo.svg" alt="" width={24} height={24} />
          {appName}
        </>
      ),
      url: "/docs"
    }
  };
}
