import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, DM_Sans } from "next/font/google";
import "./globals.css";

const sans = DM_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
});

const serif = Cormorant_Garamond({
  variable: "--font-serif",
  subsets: ["latin"],
});

const OG_IMAGE = {
  url: "/og.jpg",
  width: 1200,
  height: 675,
  alt: "An eye specimen floating above a plinth, beside the Ocularium wordmark",
};

/**
 * Absolute URLs for og:image and friends. Resolved per host so a preview
 * deployment does not advertise another origin's assets:
 *   1. NEXT_PUBLIC_SITE_URL — explicit override, wins everywhere
 *   2. VERCEL_PROJECT_PRODUCTION_URL — the project's stable production domain
 *   3. the original Cloudflare/OpenAI host
 */
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "https://anatomy-atelier.openai.site");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Ocularium — Anatomy of vision, in 3D",
  description:
    "Explore the human eye in precision 3D: 23 layered structures, clinical conditions, and the physiology of vision — an elegant, interactive anatomy lab.",
  applicationName: "Ocularium",
  keywords: ["eye anatomy", "3D anatomy", "human eye", "ophthalmology", "medical education", "interactive learning", "eye conditions"],
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    shortcut: "/favicon.svg",
    apple: { url: "/apple-touch-icon.png", sizes: "180x180" },
  },
  openGraph: {
    type: "website",
    siteName: "Ocularium",
    title: "Ocularium — Anatomy of vision, in 3D",
    description: "Explore the human eye in precision 3D: 23 layered structures, clinical conditions, and the physiology of vision.",
    images: [OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: "Ocularium — Anatomy of vision, in 3D",
    description: "Explore the human eye in precision 3D: 23 layered structures, clinical conditions, and the physiology of vision.",
    images: [OG_IMAGE],
  },
};

export const viewport: Viewport = {
  themeColor: "#f7f0e7",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${sans.variable} ${serif.variable}`}
      >
        {children}
      </body>
    </html>
  );
}
