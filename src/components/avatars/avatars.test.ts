import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AvatarDetailView, AvatarView, VoiceProfileView } from "@/application/avatar-actions";
import { avatarCreateHref, avatarFormState, avatarPayload, defaultForLabel, queryAvatars } from "@/application/avatar-library";
import { initialCreateState } from "@/application/create-flow";
import { isDarkRoute } from "../shell/nav";
import { AvatarLibrary } from "./avatar-library";
import { AvatarProfile, RevisionHistory } from "./avatar-profile";
import { AvatarStudioForm } from "./avatar-studio-form";

// O formulário navega com o router do App Router; nos testes estáticos ele é um stub.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

/** L8.7 — Avatar Studio: biblioteca, perfil (abas), histórico de revisões e formulário. */

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const avatar = (id: string, over: Partial<AvatarView> = {}): AvatarView => ({
  id, revision: 1, name: id, active: true, imageUrl: null, gender: "woman", genderLabel: "Mulher", visualAgeRange: "30s", hair: "", appearanceDescriptors: "", appearancePrompt: "",
  defaultOutfit: "", defaultEnvironment: "", environment: null, environmentLabel: null, speakingStyle: "", personality: "", tags: [], preferredProductCategories: [], defaultForTags: [],
  voiceProfileId: null, voiceName: null, referenceImage: null, updatedAt: "2026-10-22T12:00:00Z", ...over,
});
const CRISTINA = avatar("avatar_cris", { name: "Cristina", imageUrl: "/api/uploads/avatar_cris/img_1.png", referenceImage: { ownerId: "avatar_cris", imageId: "img_1.png" }, revision: 3, voiceProfileId: "voice_clara", voiceName: "Clara BR", tags: ["beleza", "cabelo"], defaultForTags: ["cabelo", "beleza"], hair: "castanho ondulado", appearancePrompt: "mulher de 30 anos, luz natural", speakingStyle: "frases curtas", preferredProductCategories: ["skincare"] });
const RAFAEL = avatar("avatar_raf", { name: "Rafael Lima", gender: "man", genderLabel: "Homem", tags: ["tecnologia"], voiceName: "Lucas BR" });
const BIA = avatar("avatar_bia", { name: "Bia", active: false, tags: ["moda"] });
const LU = avatar("avatar_lu", { name: "Lu", tags: ["casa"] });
const VOICES: VoiceProfileView[] = [{ id: "voice_clara", name: "Clara BR", style: "Feminina, calorosa e próxima", locale: "pt-BR", provider: "elevenlabs", builtIn: true, enabled: true, stability: 0.5, speed: 1, similarity: 0.75 }];
const DETAIL: AvatarDetailView = {
  avatar: CRISTINA,
  revisions: [{ revision: 3, current: true, updatedAt: "2026-10-22T12:00:00Z", imageUrl: "/api/uploads/avatar_cris/img_3.png" }, { revision: 2, current: false, updatedAt: "2026-10-21T12:00:00Z", imageUrl: null }, { revision: 1, current: false, updatedAt: "2026-10-20T12:00:00Z", imageUrl: "/api/uploads/avatar_cris/img_1.png" }],
  usage: { count: 2, recent: [{ id: "c1", name: "Secador Taiff", createdAt: "2026-10-22T12:00:00Z", thumbnailUrl: null }] },
};

describe("biblioteca", () => {
  it("cards visuais: foto, nome, voz, tags, ✦ Padrão para, Ativo/Inativo; ações reais", () => {
    const html = renderToStaticMarkup(createElement(AvatarLibrary, { avatars: [CRISTINA, RAFAEL, BIA, LU] }));
    const t = text(html);
    for (const s of ["Avatares", "Apresentadores consistentes para seus vídeos.", "Criar avatar", "Cristina", "Clara BR", "beleza · cabelo", "✦ Padrão para cabelo e beleza", "Ativo", "Inativo"]) expect(t).toContain(s);
    expect(html).toContain(`href="${avatarCreateHref("avatar_cris")}"`);
    expect(html).toContain('href="/avatars/avatar_cris/edit"');
    // Inativo não pode ser usado em vídeo novo (o Create só aceita ativos).
    expect(html).not.toContain(`href="${avatarCreateHref("avatar_bia")}"`);
    expect(t).not.toMatch(/defaultForTags|\[/);
  });

  it("sem foto: iniciais e fallback acessível (nunca <img> quebrada)", () => {
    const html = renderToStaticMarkup(createElement(AvatarLibrary, { avatars: [RAFAEL] }));
    expect(html).not.toContain("<img");
    expect(html).toContain('aria-label="Rafael Lima (sem foto)"');
    expect(text(html)).toContain("RL");
  });

  it("busca/filtros só com avatares suficientes; vazio com CTA", () => {
    expect(renderToStaticMarkup(createElement(AvatarLibrary, { avatars: [CRISTINA] }))).not.toContain("data-avatar-tools");
    const html = renderToStaticMarkup(createElement(AvatarLibrary, { avatars: [CRISTINA, RAFAEL, BIA, LU] }));
    expect(html).toContain("data-avatar-tools");
    expect(html).toMatch(/<label[^>]*class="sr-only"[^>]*>Buscar avatares<\/label>/);
    for (const f of ["all", "active", "inactive", "tag:beleza"]) expect(html).toContain(`data-avatar-filter="${f}"`);
    expect(text(renderToStaticMarkup(createElement(AvatarLibrary, { avatars: [] })))).toContain("Nenhum apresentador ainda.");
  });

  it("busca por nome, tag e voz; filtros ativos/inativos/tag", () => {
    const all = [CRISTINA, RAFAEL, BIA, LU];
    expect(queryAvatars(all, { search: "clara" }).map((a) => a.id)).toEqual(["avatar_cris"]);
    expect(queryAvatars(all, { search: "TECNOLOGIA" }).map((a) => a.id)).toEqual(["avatar_raf"]);
    expect(queryAvatars(all, { filter: "inactive" }).map((a) => a.id)).toEqual(["avatar_bia"]);
    expect(queryAvatars(all, { filter: "active" })).toHaveLength(3);
    expect(queryAvatars(all, { filter: { tag: "cabelo" } }).map((a) => a.id)).toEqual(["avatar_cris"]);
    expect(defaultForLabel([])).toBeNull();
    expect(defaultForLabel(["cabelo"])).toBe("Padrão para cabelo");
    expect(defaultForLabel(["a", "b", "c", "d"])).toBe("Padrão para a, b e c +1");
  });

  it("Usar → Create com ?avatar= (o Create revalida: inativo/inexistente vira automático)", () => {
    const search = Object.fromEntries(new URL(avatarCreateHref("avatar_cris"), "http://x").searchParams);
    expect(initialCreateState({ newProductId: "p", search, avatarIds: ["avatar_cris"] }).draft.avatar).toBe("avatar_cris");
    expect(initialCreateState({ newProductId: "p", search, avatarIds: [] }).draft.avatar).toBe("auto");
    expect(isDarkRoute("/avatars")).toBe(true);
    expect(isDarkRoute("/avatars/avatar_cris/edit")).toBe(true);
  });
});

describe("perfil", () => {
  const profile = (tab?: Parameters<typeof AvatarProfile>[0]["initialTab"]) => renderToStaticMarkup(createElement(AvatarProfile, { detail: DETAIL, voices: VOICES, initialTab: tab }));

  it("visão geral: status, voz, revisão atual, uso real, tags e identidade", () => {
    const html = profile();
    const t = text(html);
    for (const s of ["Cristina", "Ativo", "Clara BR", "Revisão 3 · 22/10/2026", "Usado em 2 projetos", "Referência de identidade ativa", "Usado recentemente", "Secador Taiff", "Usar em novo vídeo", "Editar"]) expect(t).toContain(s);
    expect(html).toContain('role="tablist"');
    for (const tab of ["Visão geral", "Aparência", "Voz", "Preferências", "Histórico"]) expect(t).toContain(tab);
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Visão geral/);
    expect(t).not.toMatch(/voice_clara|avatar_cris\b(?!\/)/);
  });

  it("sem uso calculável: não mostra contagem inventada", () => {
    const t = text(renderToStaticMarkup(createElement(AvatarProfile, { detail: { ...DETAIL, usage: null }, voices: VOICES })));
    expect(t).not.toMatch(/Usado em|Ainda não usado/);
  });

  it("aparência: campos reais; descrição-base no Avançado", () => {
    const t = text(profile("appearance"));
    for (const s of ["Apresenta como", "Mulher", "Idade visual", "30–39 anos", "Cabelo", "castanho ondulado", "Avançado", "mulher de 30 anos, luz natural", "cria uma nova revisão"]) expect(t).toContain(s);
  });

  it("voz: nome e descrição, sem ID técnico e sem botão de prévia", () => {
    const html = profile("voice");
    const t = text(html);
    for (const s of ["Clara BR", "Feminina, calorosa e próxima", "pt-BR", "frases curtas", "A prévia de áudio da voz ainda não está disponível."]) expect(t).toContain(s);
    expect(html).not.toMatch(/<audio|voice_clara|Ouvir|Tocar/);
  });

  it("preferências: Padrão para, categorias e tags reais", () => {
    const t = text(profile("preferences"));
    for (const s of ["Padrão para", "cabelo", "beleza", "Categorias preferidas", "skincare"]) expect(t).toContain(s);
  });

  it("histórico: revisão atual e anteriores com data e foto; nada de motivo inventado", () => {
    const html = renderToStaticMarkup(createElement(RevisionHistory, { revisions: DETAIL.revisions, name: "Cristina" }));
    const t = text(html);
    for (const s of ["Revisão 3", "Atual", "22/10/2026", "Revisão 2", "21/10/2026", "Revisão 1", "20/10/2026"]) expect(t).toContain(s);
    expect(html).toMatch(/aria-pressed="true"[^>]*>.*Revisão 3/);
    expect(html).toContain('aria-label="Cristina (sem foto)"');
    expect(t).not.toMatch(/roupa alterada|nova foto|motivo/i);
  });
});

describe("formulário (criar/editar)", () => {
  it("4 seções, upload compartilhado e os MESMOS campos do formulário anterior", () => {
    const html = renderToStaticMarkup(createElement(AvatarStudioForm, { avatarId: "avatar_new", voices: VOICES }));
    const t = text(html);
    for (const s of ["Novo avatar", "01", "Identidade", "02", "Aparência", "03", "Voz", "04", "Preferências", "Foto de referência", "Nome", "Apresenta como", "Idade visual", "Personalidade", "Cabelo", "Roupa base", "Ambiente padrão", "Cenário base", "Avançado", "Estilo de fala", "Tags", "Padrão para", "Categorias preferidas", "Salvar avatar", "Clara BR"]) expect(t).toContain(s);
    expect(html).toContain("data-photo-state");
    expect(html).toContain('role="radiogroup" aria-label="Voz"');
    expect(t).not.toMatch(/Desativar|Excluir/);
  });

  it("edição: Desativar/Excluir (com confirmação) e revisão atual no cabeçalho", () => {
    const t = text(renderToStaticMarkup(createElement(AvatarStudioForm, { avatarId: "avatar_cris", initial: CRISTINA, voices: VOICES })));
    for (const s of ["Editar Cristina", "Revisão 3", "Desativar", "Excluir", "Salvar avatar", "Imagem pronta"]) expect(t).toContain(s);
  });

  it("payload idêntico ao do formulário do Lote 6 (mesma action, mesma regra de revisão)", () => {
    const payload = avatarPayload("avatar_cris", avatarFormState(CRISTINA));
    expect(Object.keys(payload).sort()).toEqual(["appearanceDescriptors", "appearancePrompt", "defaultEnvironment", "defaultForTags", "defaultOutfit", "gender", "hair", "id", "name", "personality", "preferredProductCategories", "referenceImage", "speakingStyle", "tags", "visualAgeRange", "voiceProfileId"].sort());
    expect(payload.referenceImage).toEqual({ ownerId: "avatar_cris", imageId: "img_1.png" });
    const bare = avatarPayload("avatar_new", avatarFormState());
    expect(bare).not.toHaveProperty("referenceImage");
    expect(bare).not.toHaveProperty("voiceProfileId");
    expect(bare).not.toHaveProperty("environment");
  });
});
