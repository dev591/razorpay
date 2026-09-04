import type { Metadata } from "next";
import { Geist, Geist_Mono, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import SmoothScroll from "@/components/SmoothScroll";
import NavBar from "@/components/NavBar";
import Footer from "@/components/Footer";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Razorpay sets headlines in TASA Orbiter Display, which isn't publicly
// licensed — Plus Jakarta Sans is the closest geometric grotesk with the same
// slightly-humanist counters at display sizes.
const display = Plus_Jakarta_Sans({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: {
    default: "Mandate — agentic commerce on Razorpay",
    template: "%s — Mandate",
  },
  description:
    "A bounded, gated, audit-trailed agent-to-agent commerce demo built on Razorpay test-mode APIs.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${display.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-paper text-ink">
        <SmoothScroll />
        <NavBar />
        {children}
        <Footer />
      </body>
    </html>
  );
}
