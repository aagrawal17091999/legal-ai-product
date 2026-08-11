import type { Metadata } from "next";
import { Instrument_Serif, DM_Sans } from "next/font/google";
import "./globals.css";
import { SITE_URL } from "@/lib/site";

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-serif",
  display: "swap",
});

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const TITLE =
  "Legal Brain — AI Legal Research, Document Q&A, Translation & OCR for Indian Advocates";
const DESCRIPTION =
  "The AI workspace for Indian lawyers. Ask Indian case law and get cited, verifiable answers from Supreme Court and High Court judgments; chat with your own case files; and translate or OCR scanned documents into clean, court-ready Word and PDF output. Start free.";

export const metadata: Metadata = {
  // metadataBase is what makes the relative image path below resolve to an
  // absolute URL. Without it, every shared link renders with no preview card.
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "Legal Brain",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "Legal Brain",
    title: TITLE,
    description: DESCRIPTION,
    url: "/",
    locale: "en_IN",
    images: [{ url: "/logo.png", width: 242, height: 256, alt: "Legal Brain" }],
  },
  twitter: {
    card: "summary",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/logo.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${instrumentSerif.variable} ${dmSans.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
