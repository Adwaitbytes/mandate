import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { RunningHead } from "@/components/running-head";
import { jurorRoster, jurors, promptFile, promptHash } from "@/lib/config";
import { Providers } from "./providers";
import "./globals.css";

const garamond = localFont({
  src: [
    { path: "../fonts/eb-garamond-roman.woff2", weight: "400 800", style: "normal" },
    { path: "../fonts/eb-garamond-italic.woff2", weight: "400 800", style: "italic" },
  ],
  variable: "--font-garamond",
  display: "swap",
  fallback: ["Iowan Old Style", "Georgia", "serif"],
  adjustFontFallback: "Times New Roman",
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: { default: "Mandate", template: "%s, Mandate" },
  description:
    "Write how your governance votes should be cast. Three model jurors read every proposal against it and a reactive contract casts the vote unless you veto.",
  openGraph: { type: "website", siteName: "Mandate" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f4f0" },
    { media: "(prefers-color-scheme: dark)", color: "#15130f" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB" className={garamond.variable}>
      <body>
        <a className="skip" href="#main">
          Skip to the page
        </a>
        <RunningHead />
        <Providers>
          <main id="main" className="page">
            {children}
          </main>
        </Providers>
        <footer className="colophon">
          <span>Jurors: {jurors.map((j) => `${j.id}, ${jurorRoster(j)}`).join("; ")}</span>
          <span>
            Juror prompt {promptFile}, keccak256 <span className="hash">{promptHash}</span>
          </span>
        </footer>
      </body>
    </html>
  );
}
