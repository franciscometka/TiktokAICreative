import type { NextConfig } from "next";

/**
 * Lote 7: na Vercel (NEXT_PUBLIC_RUNTIME_MODE=cloud) o Next é só a interface: Remotion, Chrome,
 * FFmpeg, pg e PGlite rodam no Render (API/worker). Excluí-los do trace mantém as funções
 * pequenas e garante que nada pesado execute no frontend.
 */
const cloud = process.env.NEXT_PUBLIC_RUNTIME_MODE === "cloud";

const nextConfig: NextConfig = {
  // O renderer Remotion roda só no servidor (bundler webpack + Chrome headless): não empacotar.
  serverExternalPackages: ["@remotion/bundler", "@remotion/renderer", "@remotion/compositor-win32-x64-msvc", "remotion", "pg"],
  ...(cloud
    ? {
        outputFileTracingExcludes: {
          "*": [
            "node_modules/@remotion/**", "node_modules/.remotion/**", "node_modules/remotion/**",
            "node_modules/@electric-sql/**", "node_modules/pg/**",
            "outputs/**", "data/**", "remotion/**", "supabase/**",
          ],
        },
      }
    : {}),
};

export default nextConfig;
