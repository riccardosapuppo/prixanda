import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { InputWatcher } from "../components/frame/InputWatcher.tsx";
import { SiteFrame } from "../components/frame/SiteFrame.tsx";
import { copy } from "../content/copy.ts";
import { SiteData } from "../data/provider.tsx";
import "./globals.css";
import "./site.css";

export const metadata: Metadata = {
  title: { default: copy.service, template: `%s · ${copy.service}` },
  description: `${copy.service}, a fictional independent music service in a personal software project: plans and prices by market, campaigns, a demo subscription. Simulated data; no real payments.`,
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f3f3ef",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col">
        <InputWatcher />
        <SiteData>
          <SiteFrame>{children}</SiteFrame>
        </SiteData>
      </body>
    </html>
  );
}
