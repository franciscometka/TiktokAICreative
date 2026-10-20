import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { AppShell } from "@/components/v2/app-shell";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Creative Factory",
  description: "Vídeos UGC para TikTok Shop: foto, ideia, avatar e duração.",
};

/**
 * Lote 6: navegação V2 (sidebar). O aviso de modo de execução (MOCK/REAL) saiu da faixa global e
 * fica em Configurações → Avançado; as proteções de custo/aprovação continuam no fluxo.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={inter.variable}>
      <body className="min-h-screen font-sans antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
