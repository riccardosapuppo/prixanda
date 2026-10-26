// The console's document. Every page is static HTML and asks for its data in
// the browser (next.config.ts says why).
import "design/fonts/atkinson.css";
import "design/fonts/archivo.css";
import "./globals.css";
import { BRAND } from "design";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Providers } from "./providers.tsx";

export const metadata: Metadata = {
  title: { default: BRAND.platform, template: `%s · ${BRAND.platform}` },
  description: `${BRAND.platform}, the console where the commercial team of ${BRAND.service} creates, simulates, approves and follows offers. Independent personal project with a fictional business and synthetic data.`,
  // Linked from the portfolio, never indexed: search engines read the page, follow its links, and list none of it.
  robots: { index: false, follow: true },
};

export const viewport: Viewport = { themeColor: "#1e2a55" };

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
