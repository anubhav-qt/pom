import type { Metadata, Viewport } from "next";
import { Inter, Italiana, JetBrains_Mono } from "next/font/google";

import { cn } from "@/lib/utils";

import "./globals.css";

// Self-hosted at build time by next/font — no runtime request to Google, so
// this costs nothing at request time and works offline once built.
const sans = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });
// The storefront's wordmark face, so the OMS header reads as the same brand.
const logo = Italiana({ subsets: ["latin"], weight: "400", variable: "--font-logo", display: "swap" });

export const metadata: Metadata = {
  title: "POM",
  description: "Order management across Amazon, Flipkart and Meesho",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Lets env(safe-area-inset-*) work, so the bottom bars clear the iPhone home indicator.
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn(sans.variable, mono.variable, logo.variable)}>
      <body className="min-h-screen min-h-[100dvh] font-sans antialiased">{children}</body>
    </html>
  );
}
