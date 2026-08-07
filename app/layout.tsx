import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/components/theme-provider";
import SuppressKnownErrors from "@/components/SuppressKnownErrors";
import "streamdown/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "GenUIdance",
  description: "Generative UI for decision-making — AI that builds your criteria map in real time",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Initial SSR value from the "gs_locale" cookie (mirrors app/page.tsx's client-side locale
  // state) — the runtime toggle then updates document.documentElement.lang directly on change.
  const cookieStore = await cookies();
  const initialLocale = cookieStore.get("gs_locale")?.value === "en" ? "en" : "ko";

  return (
    <html lang={initialLocale} suppressHydrationWarning>
      <head>
        <meta name="referrer" content="no-referrer" />
        <style dangerouslySetInnerHTML={{
          __html: `
            * {
              font-family: 'NanumSquareNeo', -apple-system, BlinkMacSystemFont, system-ui, Roboto, sans-serif !important;
            }
          `
        }} />
      </head>
      <body className="antialiased">
        <ThemeProvider>
          <SuppressKnownErrors />
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
