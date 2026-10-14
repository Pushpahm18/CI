import type { Metadata } from "next";
import { Inter, Ubuntu } from "next/font/google";
import { SessionProvider } from "next-auth/react";
import "./globals.css";
import { CiSessionProvider } from "@/context/ci-session-context";
import { AppShell } from "@/components/layout/app-shell";

// Inter: excellent at dense tabular UI (the thing this app is mostly made
// of) while reading as a modern, native-app-grade typeface — the biggest
// single lever for the "feel more modern" ask. Falls back to -apple-system
// (San Francisco on Mac) and Segoe UI (Windows) if the web font can't load.
// Also the ASM brand guideline's approved body/label/form/table/nav font.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

// ASM brand guideline's approved heading font — Regular/Medium/Bold, used
// for page titles, section headings, and subheadings only (see the global
// h1–h6 rule in globals.css). Falls back to Inter (via --font-heading in
// globals.css) if the web font can't load, never to a generic system font.
const ubuntu = Ubuntu({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-ubuntu",
  display: "swap",
});

export const metadata: Metadata = {
  title: "CI | Competitive Intelligence",
  description: "Competitive Intelligence — competitive market share application.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`h-full antialiased ${inter.variable} ${ubuntu.variable}`}>
      <body className="h-full overflow-hidden">
        {/* Makes the Auth.js session available to client components via
            useSession(); CiSessionProvider then resolves the signed-in
            person's CI role and Customer/Segment scope. */}
        <SessionProvider>
          <CiSessionProvider>
            <AppShell>{children}</AppShell>
          </CiSessionProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
