import { describe, expect, it } from "vitest";
import { InMemoryAvatarLibraryStore } from "@/storage/avatar-store";
import { PNG_BYTES, tempUploads } from "@/test/app-fixtures";
import { ugcHarness } from "@/test/ugc-harness";
import { getAvatarDetail, saveAvatar, archiveAvatar } from "./avatar-actions";
import { avatarFormState, avatarPayload } from "./avatar-library";
import { startVideoV2 } from "./create-v2";

/** L8.7 — perfil do avatar: revisões (as que o domínio já guarda) e uso nos projetos. */

async function setup() {
  const h = await ugcHarness();
  const { uploads } = await tempUploads();
  const avatars = new InMemoryAvatarLibraryStore();
  let tick = 0;
  const deps = { service: h.service, uploads, avatars, rendersDir: h.config.rendersDir, audioDir: h.config.audioDir, defaultBudget: { maxCostPerCreativeBrl: 200, maxCostPerCampaignBrl: 500, allowOverBudget: false }, clock: () => `2026-10-2${tick++}T12:00:00.000Z` };
  return { h, deps, uploads, avatars };
}

describe("revisões e perfil", () => {
  it("o payload do Avatar Studio cria revisão só quando a identidade muda (regra do servidor preservada)", async () => {
    const { deps, uploads } = await setup();
    const face1 = await uploads.save("avatar_cris", { bytes: PNG_BYTES, size: PNG_BYTES.length, declaredType: "image/png" });
    const base = { ...avatarFormState(), name: "Cristina", tags: ["beleza"], defaultForTags: ["cabelo"], imageId: face1.id };
    expect((await saveAvatar(deps, avatarPayload("avatar_cris", base) as never)).ok).toBe(true);
    // Nome/tags: mesma revisão.
    await saveAvatar(deps, avatarPayload("avatar_cris", { ...base, name: "Cristina S.", tags: ["beleza", "unhas"] }) as never);
    let detail = (await getAvatarDetail(deps, "avatar_cris"))!;
    expect(detail.revisions.map((r) => [r.revision, r.current])).toEqual([[1, true]]);
    expect(detail.avatar).toMatchObject({ name: "Cristina S.", revision: 1 });
    // Aparência: revisão nova. Foto nova: outra revisão.
    await saveAvatar(deps, avatarPayload("avatar_cris", { ...base, hair: "castanho ondulado" }) as never);
    const face2 = await uploads.save("avatar_cris", { bytes: PNG_BYTES, size: PNG_BYTES.length, declaredType: "image/png" });
    await saveAvatar(deps, avatarPayload("avatar_cris", { ...base, hair: "castanho ondulado", imageId: face2.id }) as never);
    detail = (await getAvatarDetail(deps, "avatar_cris"))!;
    expect(detail.revisions.map((r) => [r.revision, r.current])).toEqual([[3, true], [2, false], [1, false]]);
    expect(detail.revisions[0]!.imageUrl).toContain(face2.id);
    expect(detail.revisions[2]!.imageUrl).toContain(face1.id);
    expect(detail.revisions.every((r) => /^2026-10-2\d/.test(r.updatedAt))).toBe(true);
    // Resumo seguro: sem motivo inventado, sem caminho de disco, sem voiceId de provider.
    expect(Object.keys(detail.revisions[0]!).sort()).toEqual(["current", "imageUrl", "revision", "updatedAt"]);
    expect(JSON.stringify(detail)).not.toMatch(/providerVoiceId|uri"|outputs\//);
  });

  it("uso nos projetos: só projetos que pediram este avatar; arquivado não tem perfil", async () => {
    const { deps, uploads } = await setup();
    await saveAvatar(deps, { name: "Rafael", gender: "man", tags: ["tecnologia"] });
    const rafael = (await deps.avatars.listAvatars())[0]!;
    expect((await getAvatarDetail(deps, rafael.id))!.usage).toEqual({ count: 0, recent: [] });
    const photo = await uploads.save("prod_fone", { bytes: PNG_BYTES, size: PNG_BYTES.length, declaredType: "image/png" });
    const started = await startVideoV2(deps, { productId: "prod_fone", name: "Fone Pro", imageIds: [photo.id], idea: "Rafael mostrando o fone", duration: 30, avatar: rafael.id });
    if (!started.ok) throw new Error(started.error.message);
    await startVideoV2(deps, { productId: "prod_fone", name: "Outro", imageIds: [photo.id], idea: "Sem avatar escolhido", duration: 30 });
    const usage = (await getAvatarDetail(deps, rafael.id))!.usage!;
    expect(usage.count).toBe(1);
    expect(usage.recent[0]).toMatchObject({ id: started.value.campaignId, name: "Fone Pro" });
    // Sem leitor de projetos no processo: não inventa contagem.
    expect((await getAvatarDetail({ uploads: deps.uploads, avatars: deps.avatars }, rafael.id))!.usage).toBeNull();
    await archiveAvatar(deps, rafael.id);
    expect(await getAvatarDetail(deps, rafael.id)).toBeUndefined();
  });
});
