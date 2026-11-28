import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "NIGHTLIFEZ — Discover. Connect. Experience.",
  description:
    "Discover and book concerts, parties, festivals, nightlife, comedy, music, sports, workshops and experiences on NIGHTLIFEZ.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/icon.svg",
    apple: "/icon.svg"
  },
  openGraph: {
    title: "NIGHTLIFEZ — Discover. Connect. Experience.",
    description:
      "Explore curated live events, concerts, festivals, nightlife and experiences on NIGHTLIFEZ.",
    siteName: "NIGHTLIFEZ",
    type: "website"
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col bg-[#f6f7fb] text-[#111319] antialiased selection:bg-[#efeafe] selection:text-[#5b3df5]">
        <div className="flex-1">{children}</div>
        <footer className="border-t border-[#e4e6f0] bg-white py-8 text-xs text-[#5e6473]">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 sm:px-6">
            <div>
              <span className="text-sm font-extrabold tracking-tight text-[#111319]">
                NIGHTLIFEZ
              </span>
              <span className="ml-2 font-semibold text-[#5b3df5]">
                Discover. Connect. Experience.
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-4 font-semibold">
              <Link href="/events" className="hover:text-[#111319]">Events</Link>
              <Link href="/movies" className="hover:text-[#111319]">Movies</Link>
              <Link href="/dining" className="hover:text-[#111319]">Dining</Link>
              <Link href="/play" className="hover:text-[#111319]">Play</Link>
              <Link href="/bookings" className="hover:text-[#111319]">Ticket Wallet</Link>
              <Link href="/account" className="hover:text-[#111319]">Account</Link>
              <span className="text-[#cbd0e0]" aria-hidden="true">|</span>
              <Link href="/organiser" className="text-[#5b3df5] hover:underline">Organiser</Link>
              <Link href="/venue-portal" className="text-[#5b3df5] hover:underline">Venues</Link>
              <Link href="/staff" className="text-[#5b3df5] hover:underline">Staff Scanner</Link>
              <Link href="/admin" className="text-[#5b3df5] hover:underline">Admin</Link>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
