import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppShell } from "@/components/v2/app-shell";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Creative Factory",
  description: "Vídeos UGC para TikTok Shop: foto, ideia, avatar e duração.",
};

/** L8.1: safe areas (bottom nav no iPhone) e barra do navegador no tom do shell. */
export const viewport: Viewport = { viewportFit: "cover", themeColor: "#09090b", colorScheme: "dark" };

/**
 * Lote 6: navegação V2 (sidebar). O aviso de modo de execução (MOCK/REAL) saiu da faixa global e
 * fica em Configurações → Avançado; as proteções de custo/aprovação continuam no fluxo.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={`${geist.variable} ${geistMono.variable}`}>
      <body className="min-h-screen font-sans antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
