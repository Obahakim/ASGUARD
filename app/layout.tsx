import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ASGUARD Operations",
  description: "Operator dashboard for non-custodial NEAR approvals, audit, and wallet monitoring.",
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#f3f5f7] text-[#172b3d] antialiased">
        {children}
      </body>
    </html>
  );
}
