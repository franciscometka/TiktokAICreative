import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VoiceProfileSchema } from "@/domain/avatar";
import { FileAvatarLibraryStore, InMemoryAvatarLibraryStore } from "@/storage/avatar-store";
import { PNG_BYTES, tempUploads } from "@/test/app-fixtures";
import { archiveAvatar, avatarView, builtInVoiceProfiles, listAvatarViews, listVoiceProfileViews, newAvatarId, saveAvatar, saveVoiceProfile, setAvatarActive } from "./avatar-actions";

let tick = 0;
const clock = () => `2026-10-20T10:00:${String(tick++).padStart(2, "0")}.000Z`;

async function deps() {
  const { uploads } = await tempUploads();
  return { avatars: new InMemoryAvatarLibraryStore(), uploads, clock };
}

describe("Biblioteca de avatares — CRUD (Lote 6)", () => {
  it("cria, lista, edita, desativa e exclui (arquiva) um avatar com tags livres", async () => {
    const d = await deps();
    const id = newAvatarId();
    const photo = await d.uploads.save(id, { bytes: PNG_BYTES, size: PNG_BYTES.length, declaredType: "image/png" });
    const created = await saveAvatar(d, { id, name: "Marina", gender: "woman", tags: ["Beleza", "cabelo", "beleza"], personality: "Natural e simpática", voiceProfileId: "voice_clara", defaultEnvironment: "quarto moderno", referenceImage: { ownerId: id, imageId: photo.id }, defaultForTags: ["Cabelo"] });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value).toMatchObject({ id, revision: 1, name: "Marina", tags: ["beleza", "cabelo"], defaultForTags: ["cabelo"], voiceName: "Clara BR", active: true });
    expect(created.value.imageUrl).toBe(`/api/uploads/${id}/${photo.id}`);
    expect((await listAvatarViews(d)).map((a) => a.id)).toEqual([id]);

    // Nome/tags/voz: mesma revisão. Aparência/roupa: nova revisão; a anterior continua recuperável.
    const renamed = await saveAvatar(d, { id, name: "Marina BR", gender: "woman", tags: ["beleza"], voiceProfileId: "voice_bia", defaultEnvironment: "quarto moderno" });
    expect(renamed.ok && renamed.value.revision).toBe(1);
    const restyled = await saveAvatar(d, { id, name: "Marina BR", gender: "woman", tags: ["beleza"], defaultEnvironment: "quarto moderno", defaultOutfit: "camisa jeans" });
    expect(restyled.ok && restyled.value.revision).toBe(2);
    expect((await d.avatars.getAvatarRevision(id, 1)).defaultOutfit).toBe("");
    expect((await d.avatars.getAvatarRevision(id, 2)).defaultOutfit).toBe("camisa jeans");

    const off = await setAvatarActive(d, id, false);
    expect(off.ok && off.value.active).toBe(false);
    expect((await archiveAvatar(d, id)).ok).toBe(true);
    expect(await listAvatarViews(d)).toEqual([]);
    // Jobs antigos continuam resolvendo a revisão que usaram.
    expect((await d.avatars.getAvatarRevision(id, 2)).name).toBe("Marina BR");
  });

  it("valida campos e voz (mensagens por campo, sem gravar)", async () => {
    const d = await deps();
    const bad = await saveAvatar(d, { name: "", gender: "x" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.fieldErrors ?? {})).toEqual(expect.arrayContaining(["name", "gender"]));
    const noVoice = await saveAvatar(d, { name: "Lucas", gender: "man", voiceProfileId: "voice_inexistente" });
    expect(noVoice.ok).toBe(false);
    expect(await listAvatarViews(d)).toEqual([]);
  });

  it("persistência em arquivo: revisões sobrevivem a um novo processo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "avatars-"));
    const { uploads } = await tempUploads();
    const first = { avatars: new FileAvatarLibraryStore(dir), uploads, clock };
    const saved = await saveAvatar(first, { name: "Lucas", gender: "man", tags: ["ferramentas", "construção"], defaultEnvironment: "oficina" });
    expect(saved.ok).toBe(true);
    const again = new FileAvatarLibraryStore(dir);
    const list = await again.listAvatars();
    expect(list.map((a) => [a.name, a.tags])).toEqual([["Lucas", ["ferramentas", "construção"]]]);
  });
});

describe("Perfis de voz", () => {
  it("vozes embutidas pt-BR + vozes salvas; providerVoiceId NUNCA vai para o browser", async () => {
    const d = await deps();
    expect(builtInVoiceProfiles().map((v) => v.id)).toEqual(["voice_clara", "voice_bia", "voice_rafael", "voice_lucas"]);
    const saved = await saveVoiceProfile(d, { name: "Marina BR", speakerProfileId: "clara", style: "calorosa", speed: 0.95, stability: 0.6, similarity: 0.8, enabled: true });
    expect(saved.ok).toBe(true);
    // Um perfil com voiceId de provider gravado no servidor (ex.: importado) continua oculto.
    await d.avatars.saveVoiceProfiles([...(await d.avatars.listVoiceProfiles()), VoiceProfileSchema.parse({
      id: "voice_secret", provider: "elevenlabs", speakerProfileId: "bia", providerVoiceId: "EL_SECRET_VOICE_ID", name: "Secreta", createdAt: clock(), updatedAt: clock(),
    })]);
    const views = await listVoiceProfileViews(d);
    expect(views.map((v) => v.name)).toEqual(expect.arrayContaining(["Clara BR", "Marina BR", "Secreta"]));
    expect(JSON.stringify(views)).not.toContain("EL_SECRET_VOICE_ID");
    expect(views.every((v) => !("providerVoiceId" in v))).toBe(true);

    const avatar = await saveAvatar(d, { name: "Bia", gender: "woman", voiceProfileId: "voice_secret" });
    expect(avatar.ok).toBe(true);
    if (avatar.ok) expect(JSON.stringify(avatarView((await d.avatars.getAvatarRecord(avatar.value.id)).current))).not.toContain("EL_SECRET_VOICE_ID");
  });

  it("recusa voz base desconhecida", async () => {
    const d = await deps();
    const result = await saveVoiceProfile(d, { name: "X", speakerProfileId: "nao_existe" });
    expect(result.ok).toBe(false);
  });
});
