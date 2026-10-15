import { describe, expect, it } from "vitest";
import { StaticPricingCatalog, PricingNotFoundError } from "@/costs/pricing-catalog";
import { resolveQualitySettings, QualitySettingsError } from "@/costs/quality";
import { pricing } from "@/test/fixtures";
import { ConfigError, DEFAULT_BUDGET, DEFAULT_LLM_POLICY, loadAppConfig, loadAppConfigSafe, readAnthropicApiKey } from "./env";
import { DEFAULT_EXCHANGE_RATE, PRICING_TABLE } from "./pricing";
import { QUALITY_PRESETS } from "./quality-presets";

describe("loadAppConfig", () => {
  it("usa defaults quando as variáveis estão vazias", () => {
    const c = loadAppConfig({ USD_BRL_EXCHANGE_RATE: "", MAX_COST_PER_CREATIVE_BRL: "" });
    expect(c.videoProvider).toBe("mock");
    expect(c.audioProvider).toBe("mock");
    expect(c.exchangeRate).toEqual(DEFAULT_EXCHANGE_RATE);
    expect(c.defaultBudget).toEqual(DEFAULT_BUDGET);
    expect(c.maxAttemptsPerScene).toBe(3);
  });

  it("lê cotação e limites do ambiente", () => {
    const c = loadAppConfig(
      {
        USD_BRL_EXCHANGE_RATE: "5.75",
        MAX_COST_PER_CREATIVE_BRL: "15",
        MAX_COST_PER_CAMPAIGN_BRL: "80",
        ALLOW_OVER_BUDGET: "true",
      },
      () => "now",
    );
    expect(c.exchangeRate).toEqual({ base: "USD", quote: "BRL", rate: 5.75, source: "env", updatedAt: "now" });
    expect(c.defaultBudget).toEqual({ maxCostPerCreativeBrl: 15, maxCostPerCampaignBrl: 80, allowOverBudget: true });
  });

  it("falha cedo com valores inválidos ou providers ainda inexistentes", () => {
    expect(() => loadAppConfig({ USD_BRL_EXCHANGE_RATE: "abc" })).toThrow(ConfigError);
    expect(() => loadAppConfig({ MAX_COST_PER_CREATIVE_BRL: "-5" })).toThrow(ConfigError);
    expect(() => loadAppConfig({ VIDEO_PROVIDER: "veo" })).toThrow(ConfigError);
    expect(() => loadAppConfig({ MAX_ATTEMPTS_PER_SCENE: "1000" })).toThrow(ConfigError);
  });

  it("mantém a interface em MOCK e explica provider inválido sem expor segredos", () => {
    const result = loadAppConfigSafe({ VIDEO_PROVIDER: "RUNWAYML", RUNWAYML_API_SECRET: "segredo" });
    expect(result.config.videoProvider).toBe("mock");
    expect(result.issues[0]).toMatchObject({ variable: "VIDEO_PROVIDER" });
    expect(result.issues[0]?.message).toMatch(/runway.*RUNWAYML/i);
    expect(JSON.stringify(result)).not.toContain("segredo");
  });
});

describe("configuração do LLM e segredos", () => {
  it("LLM_PROVIDER padrão é mock; anthropic precisa ser escolhido explicitamente", () => {
    expect(loadAppConfig({}).llmProvider).toBe("mock");
    expect(loadAppConfig({ LLM_PROVIDER: "anthropic" }).llmProvider).toBe("anthropic");
    expect(() => loadAppConfig({ LLM_PROVIDER: "openai" })).toThrow(ConfigError);
  });

  it("política de retry tem limites rígidos", () => {
    expect(loadAppConfig({}).llmPolicy).toEqual(DEFAULT_LLM_POLICY);
    expect(loadAppConfig({ LLM_MAX_VALIDATION_ATTEMPTS: "1" }).llmPolicy.maxValidationAttempts).toBe(1);
    expect(() => loadAppConfig({ LLM_MAX_VALIDATION_ATTEMPTS: "5" })).toThrow(ConfigError);
    expect(() => loadAppConfig({ LLM_MAX_TRANSPORT_RETRIES: "9" })).toThrow(ConfigError);
  });

  it("persistência padrão em arquivo, diretório configurável", () => {
    expect(loadAppConfig({})).toMatchObject({ storage: "file", dataDir: "data" });
    expect(loadAppConfig({ STORAGE: "memory", DATA_DIR: "x" })).toMatchObject({ storage: "memory", dataDir: "x" });
  });

  it("a API key NÃO entra no AppConfig; só é lida sob demanda", () => {
    const env = { ANTHROPIC_API_KEY: "sk-ant-secreta", LLM_PROVIDER: "anthropic" };
    expect(JSON.stringify(loadAppConfig(env))).not.toContain("sk-ant-secreta");
    expect(readAnthropicApiKey(env)).toBe("sk-ant-secreta");
    expect(readAnthropicApiKey({ ANTHROPIC_API_KEY: "  " })).toBeUndefined();
  });
});

describe("catálogo de preços", () => {
  it("a tabela padrão é válida e cobre todos os presets", () => {
    const catalog = new StaticPricingCatalog(PRICING_TABLE);
    for (const preset of Object.values(QUALITY_PRESETS)) {
      expect(() => catalog.requireOne(preset.video)).not.toThrow();
      expect(() => catalog.requireOne(preset.audio)).not.toThrow();
      expect(() => catalog.require(preset.llm, "per_1m_input_tokens")).not.toThrow();
      expect(() => catalog.require(preset.llm, "per_1m_output_tokens")).not.toThrow();
      expect(() => catalog.require(preset.llm, "per_1m_cache_write_tokens")).not.toThrow();
      expect(() => catalog.require(preset.llm, "per_1m_cache_read_tokens")).not.toThrow();
    }
  });

  it("rejeita entradas duplicadas e informa preço ausente", () => {
    expect(() => new StaticPricingCatalog([pricing(), pricing()])).toThrow(/duplicado/);
    const catalog = new StaticPricingCatalog([pricing()]);
    expect(() => catalog.requireOne({ provider: "x", model: "y" })).toThrow(PricingNotFoundError);
  });

  it("preços de vídeo/áudio provisórios estão explicitamente marcados", () => {
    const media = PRICING_TABLE.filter((p) => p.provider.startsWith("unassigned"));
    expect(media.length).toBeGreaterThan(0);
    expect(media.every((p) => p.isPlaceholder)).toBe(true);
  });
});

describe("resolveQualitySettings", () => {
  it("presets retornam a configuração do arquivo", () => {
    expect(resolveQualitySettings("high")).toBe(QUALITY_PRESETS.high);
  });

  it("custom exige configurações explícitas", () => {
    expect(() => resolveQualitySettings("custom")).toThrow(QualitySettingsError);
    const custom = resolveQualitySettings("custom", { ...QUALITY_PRESETS.economy, label: "Meu" });
    expect(custom.quality).toBe("custom");
  });
});

 it("Runway é opt-in e a chave nunca entra no AppConfig", () => {
  const config = loadAppConfig({ VIDEO_PROVIDER: "runway", RUNWAYML_API_SECRET: "private-secret" });
  expect(config.videoProvider).toBe("runway");
  expect(config.videosDir).toBe("outputs/videos");
  expect(JSON.stringify(config)).not.toContain("private-secret");
});
