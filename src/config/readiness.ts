import type { AppConfig, ConfigIssue } from "./env";
import { readAnthropicApiKey, readElevenLabsApiKey, readGoogleAiApiKey, readRunwayApiKey } from "./env";
import { googleUgcReadiness } from "./ugc-readiness";
import { kreaUgcReadiness } from "./krea-ugc-readiness";
import type { RuntimeReadiness } from "@/domain/readiness";
import { detectRemotionBrowser } from "@/render/remotion/browser-readiness";
import type { PreflightCheck } from "@/domain/readiness";
import { mocksAllowed } from "./execution-policy";

export function runtimeReadiness(
  config: AppConfig,
  issues: ConfigIssue[] = [],
  env: Record<string, string | undefined> = process.env,
): RuntimeReadiness {
  const anthropic = !!readAnthropicApiKey(env);
  const elevenLabs = !!readElevenLabsApiKey(env);
  const runway = !!readRunwayApiKey(env);
  const browser = detectRemotionBrowser(config.renderer.browserExecutable);
  const google = !!readGoogleAiApiKey(env);
  const ugc = googleUgcReadiness(config, env);
  const krea = kreaUgcReadiness(config, env);
  const selected = {
    planning: config.llmProvider === "anthropic" && anthropic,
    narration: config.audioProvider === "elevenlabs" && elevenLabs,
    scenes: config.videoProvider === "runway" && runway,
    avatar: runway,
    render: config.renderer.id === "remotion" && browser.available,
  };
  const allowMocks = mocksAllowed(config);
  const group = (id: RuntimeReadiness["flow"][number]["id"], label: string, checks: PreflightCheck[]) => ({ id, label, ready: checks.every(check => check.ok), checks });
  const mockOk = (selectedMock: boolean, name: string): PreflightCheck[] => selectedMock ? [{ id: "mock", label: "MOCK", ok: allowMocks, detail: allowMocks ? `${name}=mock permitido (ALLOW_MOCKS=true, só dev/teste).` : `${name}=mock exige ALLOW_MOCKS=true; no fluxo normal configure o provider REAL.` }] : [];
  const ugcGroup = config.ugc.provider === "mock" ? mockOk(true, "UGC_PROVIDER") : (config.ugc.provider === "krea" ? krea : ugc).checks;
  const flow = [
    group("config", "Configuração", [
      { id: "valid", label: "Variáveis válidas", ok: issues.length === 0, detail: issues.length ? `Inválidas: ${issues.map(issue => issue.variable).join(", ")}. Nenhuma geração até corrigir.` : "Todas as variáveis passaram na validação." },
      { id: "mocks", label: "ALLOW_MOCKS", ok: true, detail: allowMocks ? "true: mocks deliberados (dev/teste)." : "false (padrão): fluxo REAL-only, sem fallback para MOCK." },
    ]),
    group("planner", "Planejamento (Claude)", config.llmProvider === "mock" ? mockOk(true, "LLM_PROVIDER") : [
      { id: "provider", label: "LLM_PROVIDER=anthropic", ok: true, detail: "Claude selecionado." },
      { id: "key", label: "Chave Anthropic", ok: anthropic, detail: anthropic ? "ANTHROPIC_API_KEY presente; o segredo não é exibido." : "ANTHROPIC_API_KEY não configurada." },
    ]),
    group("ugc", `AI UGC (${config.ugc.provider})`, ugcGroup),
    group("narration", "Narração (dispensada com áudio nativo Veo/Krea)", config.audioProvider === "mock" ? mockOk(true, "AUDIO_PROVIDER") : [
      { id: "key", label: "Chave ElevenLabs", ok: elevenLabs, detail: elevenLabs ? "ELEVENLABS_API_KEY presente." : "ELEVENLABS_API_KEY não configurada." },
    ]),
    group("renderer", "Render (Remotion)", config.renderer.id === "mock" ? mockOk(true, "RENDERER") : [
      { id: "renderer", label: "RENDERER=remotion", ok: true, detail: "Render real selecionado." },
      { id: "browser", label: "Navegador", ok: browser.available, detail: browser.detail },
    ]),
  ];
  const blockingGroup = flow.find(item => !item.ready);
  return {
    flow,
    ...(blockingGroup ? { blocking: `${blockingGroup.label}: ${blockingGroup.checks.find(check => !check.ok)?.detail ?? "pendente"}` } : {}),
    readyForControlledRealValidation: issues.length === 0 && Object.values(selected).every(Boolean),
    issues,
    items: [
      { id: "anthropic", label: "Anthropic", selected: config.llmProvider, configured: anthropic, detail: anthropic ? "Credencial presente no servidor; o segredo não é exibido." : "ANTHROPIC_API_KEY não configurada." },
      { id: "elevenlabs", label: "ElevenLabs", selected: config.audioProvider, configured: elevenLabs, detail: elevenLabs ? "Credencial presente no servidor; o segredo não é exibido." : "ELEVENLABS_API_KEY não configurada." },
      { id: "runway", label: "Runway", selected: config.videoProvider, configured: runway, detail: runway ? "Credencial presente no servidor; o segredo não é exibido." : "RUNWAYML_API_SECRET não configurado." },
      { id: "google", label: "Google AI UGC", selected: config.ugc.provider, configured: ugc.ready, detail: ugc.ready ? "Gemini/Veo prontos; REAL ainda exige aprovação por job." : google ? (ugc.reason ?? "") : "GOOGLE_AI_API_KEY não configurada." },
      { id: "krea", label: "Krea AI UGC", selected: config.ugc.provider, configured: krea.ready, detail: krea.ready ? "Nano Banana 2/Veo 3.1 via Krea prontos; REAL ainda exige aprovação por job." : (krea.reason ?? "") },
      { id: "renderer", label: "Renderer", selected: config.renderer.id, configured: config.renderer.id === "mock" || browser.available, detail: config.renderer.id === "remotion" ? browser.detail : "Renderer MOCK selecionado; nenhum MP4 será criado." },
      { id: "browser", label: "Navegador do Remotion", selected: browser.source, configured: browser.available, detail: browser.detail },
    ],
    dependencies: [
      { stage: "planning", label: "Planejamento", detail: "REAL exige provider Anthropic selecionado, chave e aprovação do pior caso." },
      { stage: "narration", label: "Narração", detail: "REAL exige ElevenLabs selecionada, chave, roteiro, orçamento e confirmação." },
      { stage: "avatar", label: "Avatar", detail: "REAL exige preset de avatar e narração real salva com alignment válido." },
      { stage: "scenes", label: "Cena de produto", detail: "REAL exige Runway selecionada, chave, imagem local válida, prompt e duração suportada." },
      { stage: "ugc_reference", label: "Referência AI UGC", detail: "REAL exige GOOGLE_AI_API_KEY, UGC_PROVIDER=google, UGC_REAL_ALLOWED=true e foto do produto." },
      { stage: "ugc_video", label: "Cena AI UGC", detail: "REAL exige o preflight Google e uma referência aprovada; áudio nativo do Veo." },
      { stage: "render", label: "Render final", detail: "REAL exige todas as mídias, revisão de áudio resolvida, Remotion selecionado e navegador preparado." },
    ],
  };
}
