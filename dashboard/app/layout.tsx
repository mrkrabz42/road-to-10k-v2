import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { TimezoneProvider } from "@/lib/context/timezone-context";
import { Toaster } from "sonner";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  fallback: ["system-ui", "Arial", "sans-serif"],
});

export const metadata: Metadata = {
  title: "The World Is Yours | Market Analysis",
  description: "Road to 10K v2 - Market analysis assistant for human traders",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} antialiased min-h-screen bg-background`}>
        <TimezoneProvider>
          {children}
          <Toaster
            theme="dark"
            position="bottom-right"
            toastOptions={{
              style: {
                background: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                color: "hsl(var(--foreground))",
              },
            }}
          />
        </TimezoneProvider>
      </body>
    </html>
  );
}
