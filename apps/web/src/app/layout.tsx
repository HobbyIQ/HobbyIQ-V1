import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "HobbyIQ — the pricing icon of the industry",
  description:
    "Empirical fair-market value for every card in every grade, sport, and era. Portfolio tracking + actionable sell/hold/list intel for collectors and pro sellers.",
};

// CF-VIEWPORT-META (Drew, 2026-08-11). Without this, mobile browsers
// render every page at ~980px and shrink-to-fit — which is why the
// portfolio detail and storefront modals looked microscopic on Drew's
// phone. `width=device-width` tells the browser to use the actual
// viewport width; `initial-scale=1` prevents the shrink. AppShell
// already has responsive breakpoints (hamburger + drawer), those just
// weren't taking effect because the viewport was wrong.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#0a0a0a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
