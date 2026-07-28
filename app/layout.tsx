import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Funding rate arbitrage",
  description:
    "Delta-neutral funding carry across perp venues, Avantis-anchored. Funding only.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
