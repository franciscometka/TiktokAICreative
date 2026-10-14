import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TikTok AI Creative Factory",
  description: "Criativos verticais de venda para TikTok Shop com controle de custo.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">{children}</body>
    </html>
  );
}
