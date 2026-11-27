import type { Metadata } from "next";
import { RootProvider } from "fumadocs-ui/provider/next";
import { appName } from "@/lib/shared";
import "./global.css";

export const metadata: Metadata = {
  title: { default: `${appName} docs`, template: `%s | ${appName}` },
  icons: { icon: "/logo.svg" }
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
