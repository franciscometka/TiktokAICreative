import type { AppConfig, ConfigIssue } from "./env";
import { readAnthropicApiKey, readElevenLabsApiKey, readRunwayApiKey } from "./env";
import type { RuntimeReadiness } from "@/domain/readiness";
import { detectRemotionBrowser } from "@/render/remotion/browser-readiness";

export function runtimeReadiness(
  config: AppConfig,
  issues: ConfigIssue[] = [],
  env: Record<string, string | undefined> = process.env,
): RuntimeReadiness {
  const anthropic = !!readAnthropicApiKey(env);
  const elevenLabs = !!readElevenLabsApiKey(env);
  const runway = !!readRunwayApiKey(env);
  const browser = detectRemotionBrowser(config.renderer.browserExecutable);
  const selected = {
    planning: config.llmProvider === "anthropic" && anthropic,
    narration: config.audioProvider === "elevenlabs" && elevenLabs,
    scenes: config.videoProvider === "runway" && runway,
    avatar: runway,
    render: config.renderer.id === "remotion" && browser.available,
  };
  return {
    readyForControlledRealValidation: issues.length === 0 && Object.values(selected).every(Boolean),
    issues,
    items: [
      { id: "anthropic", label: "Anthropic", selected: config.llmProvider, configured: anthropic, detail: anthropic ? "Credencial presente no servidor; o segredo não é exibido." : "ANTHROPIC_API_KEY não configurada." },
      { id: "elevenlabs", label: "ElevenLabs", selected: config.audioProvider, configured: elevenLabs, detail: elevenLabs ? "Credencial presente no servidor; o segredo não é exibido." : "ELEVENLABS_API_KEY não configurada." },
      { id: "runway", label: "Runway", selected: config.videoProvider, configured: runway, detail: runway ? "Credencial presente no servidor; o segredo não é exibido." : "RUNWAYML_API_SECRET não configurado." },
      { id: "renderer", label: "Renderer", selected: config.renderer.id, configured: config.renderer.id === "mock" || browser.available, detail: config.renderer.id === "remotion" ? browser.detail : "Renderer MOCK selecionado; nenhum MP4 será criado." },
      { id: "browser", label: "Navegador do Remotion", selected: browser.source, configured: browser.available, detail: browser.detail },
    ],
    dependencies: [
      { stage: "planning", label: "Planejamento", detail: "REAL exige provider Anthropic selecionado, chave e aprovação do pior caso." },
      { stage: "narration", label: "Narração", detail: "REAL exige ElevenLabs selecionada, chave, roteiro, orçamento e confirmação." },
      { stage: "avatar", label: "Avatar", detail: "REAL exige preset de avatar e narração real salva com alignment válido." },
      { stage: "scenes", label: "Cena de produto", detail: "REAL exige Runway selecionada, chave, imagem local válida, prompt e duração suportada." },
      { stage: "render", label: "Render final", detail: "REAL exige todas as mídias, revisão de áudio resolvida, Remotion selecionado e navegador preparado." },
    ],
  };
}
