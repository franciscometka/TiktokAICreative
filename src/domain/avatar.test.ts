import { describe, expect, it } from "vitest";
import { avatarAppearance, AvatarSchema, identityChanged, normalizeTags, type Avatar } from "./avatar";
import { inferProductTags, selectAvatar } from "./avatar-selection";

export function avatar(over: Partial<Avatar> = {}): Avatar {
  return AvatarSchema.parse({
    id: "avatar_marina", revision: 1, name: "Marina", gender: "woman", tags: ["beleza", "cabelo"], personality: "Natural e simpática",
    defaultEnvironment: "quarto moderno", createdAt: "2026-10-20T10:00:00.000Z", updatedAt: "2026-10-20T10:00:00.000Z", ...over,
  });
}

describe("Avatar (Lote 6)", () => {
  it("tags são livres: normaliza caixa/espaços, remove duplicatas e aceita qualquer nicho", () => {
    expect(normalizeTags([" Beleza ", "beleza", "Pesca  Esportiva", "", "cabelo"])).toEqual(["beleza", "pesca esportiva", "cabelo"]);
    expect(avatar({ tags: ["Aquarismo", "aquarismo"] }).tags).toEqual(["aquarismo"]);
  });

  it("identidade visual separada de nome/tags/voz: só aparência, roupa, ambiente e foto mudam a identidade", () => {
    const base = avatar();
    expect(identityChanged(base, { ...base, name: "Marina 2", tags: ["fitness"], voiceProfileId: "voice_bia", personality: "animada" })).toBe(false);
    expect(identityChanged(base, { ...base, hair: "cabelo curto cacheado" })).toBe(true);
    expect(identityChanged(base, { ...base, defaultOutfit: "camisa jeans" })).toBe(true);
    expect(identityChanged(base, { ...base, referenceImage: { ownerId: "avatar_marina", imageId: "img_x", uri: "u" } })).toBe(true);
  });

  it("aparência estável a partir dos campos (prompt-base avançado tem prioridade)", () => {
    expect(avatarAppearance(avatar({ hair: "long dark wavy hair", visualAgeRange: "20s" }))).toBe("Brazilian woman in her 20s, long dark wavy hair");
    expect(avatarAppearance(avatar({ appearancePrompt: "custom base prompt" }))).toBe("custom base prompt");
  });
});

describe("Escolha automática do avatar", () => {
  const marina = avatar();
  const lucas = avatar({ id: "avatar_lucas", name: "Lucas", gender: "man", tags: ["ferramentas", "construção"], defaultEnvironment: "oficina" });
  const bia = avatar({ id: "avatar_bia", name: "Bia", tags: ["beleza"], defaultForTags: ["cabelo"], updatedAt: "2026-10-01T00:00:00.000Z" });

  it("avatar padrão por tag ganha de avatar que só combina; motivo registrado", () => {
    const sel = selectAvatar([marina, lucas, bia], { name: "Secador de cabelo 2100W", description: "Secador para cabelo" });
    expect(sel).toMatchObject({ mode: "auto", avatarId: "avatar_bia", avatarRevision: 1 });
    expect(sel.reason).toContain("Bia");
    expect(sel.reason).toContain("padrão para cabelo");
  });

  it("combina por tags do usuário (sem nichos fixos no código) e ignora avatares inativos", () => {
    expect(selectAvatar([marina, lucas], { name: "Jogo de ferramentas", description: "Kit com 40 peças" }).avatarId).toBe("avatar_lucas");
    expect(selectAvatar([{ ...lucas, active: false }, marina], { name: "Jogo de ferramentas", description: "" }).mode).toBe("synthetic");
    const pesca = avatar({ id: "avatar_rui", name: "Rui", gender: "man", tags: ["pesca"] });
    expect(selectAvatar([pesca], { name: "Molinete de pesca", description: "" }).avatarId).toBe("avatar_rui");
  });

  it("sem avatar compatível usa a geração sintética, com motivo", () => {
    const sel = selectAvatar([marina, lucas], { name: "Garrafa térmica", description: "Inox 750ml" });
    expect(sel.mode).toBe("synthetic");
    expect(sel.avatarId).toBeUndefined();
    expect(sel.reason).toMatch(/sintética/);
    expect(selectAvatar([], { name: "x", description: "" }).reason).toMatch(/Nenhum avatar ativo/);
  });

  it("tags inferidas do texto do produto (palavra inteira, plural, sem acento)", () => {
    expect(inferProductTags({ name: "Kit de Ferramentas", description: "Para construção" }, ["ferramenta", "construcao", "beleza"])).toEqual(["ferramenta", "construcao"]);
  });
});
