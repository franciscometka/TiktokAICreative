import { existsSync } from "node:fs";
import { join } from "node:path";

export interface RemotionBrowserReadiness {
  available: boolean;
  source: "configured" | "downloaded" | "missing";
  detail: string;
}

function downloadedBrowserPath(projectRoot: string): string {
  const platform = process.platform === "win32" ? "win64" : process.platform === "darwin" ? (process.arch === "arm64" ? "mac-arm64" : "mac-x64") : process.arch === "arm64" ? "linux-arm64" : "linux64";
  const executable = process.platform === "win32" ? "chrome-headless-shell.exe" : process.platform === "linux" && process.arch === "arm64" ? "headless_shell" : "chrome-headless-shell";
  return join(projectRoot, "node_modules", ".remotion", "chrome-headless-shell", platform, `chrome-headless-shell-${platform}`, executable);
}

/** Somente filesystem: nunca chama ensureBrowser e portanto nunca baixa nada. */
export function detectRemotionBrowser(browserExecutable: string | null, projectRoot = process.cwd()): RemotionBrowserReadiness {
  if (browserExecutable) {
    return existsSync(browserExecutable)
      ? { available: true, source: "configured", detail: "Executável configurado em RENDER_BROWSER_EXECUTABLE encontrado." }
      : { available: false, source: "missing", detail: "RENDER_BROWSER_EXECUTABLE aponta para um arquivo inexistente. Corrija o caminho ou execute npm run render:setup." };
  }
  return existsSync(downloadedBrowserPath(projectRoot))
    ? { available: true, source: "downloaded", detail: "Chrome Headless Shell do Remotion encontrado localmente." }
    : { available: false, source: "missing", detail: "Navegador do Remotion ausente. Execute npm run render:setup explicitamente e reinicie o servidor." };
}
