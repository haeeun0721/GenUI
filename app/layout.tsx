import type { Metadata } from "next";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/components/theme-provider";
import PanelTour from "@/components/PanelTour";
import "streamdown/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "json-render Chat Example",
  description: "AI-powered data explorer using ToolLoopAgent and json-render",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
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
          {children}
          <Toaster />
          <PanelTour />
        </ThemeProvider>
      </body>
    </html>
  );
}
