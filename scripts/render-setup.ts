/**
 * Prepara o render local do Remotion numa máquina nova (uma vez, com internet):
 * baixa o Chrome Headless Shell usado pelo Remotion. O FFmpeg já vem no pacote
 * @remotion/compositor-* instalado pelo npm. Depois disso o render funciona offline.
 *
 *   npm run render:setup
 */
import { ensureBrowser } from "@remotion/renderer";

async function main() {
  const status = await ensureBrowser({ logLevel: "info", browserExecutable: process.env.RENDER_BROWSER_EXECUTABLE ?? null });
  console.log("Navegador do Remotion pronto:", status);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
