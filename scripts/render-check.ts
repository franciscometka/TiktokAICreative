import { loadAppConfigSafe } from "../src/config/env";
import { detectRemotionBrowser } from "../src/render/remotion/browser-readiness";
import { existsSync } from "node:fs";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const { config, issues } = loadAppConfigSafe();
const browser = detectRemotionBrowser(config.renderer.browserExecutable);
for (const issue of issues) console.error(`Configuração: ${issue.message}`);
console.log(`Renderer selecionado: ${config.renderer.id}`);
console.log(`Navegador do Remotion: ${browser.available ? "disponível" : "ausente"}`);
console.log(browser.detail);
if (!browser.available) process.exitCode = 1;
