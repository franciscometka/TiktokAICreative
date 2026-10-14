import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/primitives";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Creative Factory",
  description: "Criativos verticais de venda para TikTok Shop com controle de custo.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={inter.variable}>
      <body className="min-h-screen font-sans antialiased">
        <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white/90 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
            <Link href="/" aria-label="Creative Factory — início" className="flex items-center gap-2.5 text-sm font-semibold tracking-tight text-zinc-900">
              <span className="grid size-6 place-items-center rounded bg-zinc-900 text-[11px] font-bold text-white" aria-hidden>
                CF
              </span>
              <span className="hidden sm:inline">Creative Factory</span>
            </Link>
            <nav className="flex items-center gap-1">
              <Link href="/campaigns" className={buttonClasses("ghost", "sm")}>
                Campanhas
              </Link>
              <Link href="/create" className={buttonClasses("primary", "sm")}>
                Criar campanha
              </Link>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
