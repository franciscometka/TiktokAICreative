import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectImageType, UPLOAD_LIMITS, UploadValidationError, validateImageUpload } from "@/domain/upload";
import { JPEG_BYTES, PNG_BYTES, tempUploads } from "@/test/app-fixtures";
import { InvalidUploadPathError } from "./upload-store";

const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 9]);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof UploadValidationError ? error.code : "other";
  }
  return undefined;
}

describe("validação de imagem (pura)", () => {
  it("detecta JPEG, PNG e WebP pela assinatura", () => {
    expect(detectImageType(JPEG_BYTES)).toBe("image/jpeg");
    expect(detectImageType(PNG_BYTES)).toBe("image/png");
    expect(detectImageType(WEBP_BYTES)).toBe("image/webp");
    expect(detectImageType(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeUndefined();
  });

  it("aceita imagem cujo conteúdo bate com o MIME declarado", () => {
    expect(validateImageUpload({ size: PNG_BYTES.length, declaredType: "image/png", bytes: PNG_BYTES })).toEqual({
      contentType: "image/png",
      extension: "png",
    });
  });

  it("recusa formato não suportado, conteúdo falso, vazio e tamanho excessivo", () => {
    const svg = new TextEncoder().encode("<svg/>");
    expect(codeOf(() => validateImageUpload({ size: svg.length, declaredType: "image/svg+xml", bytes: svg }))).toBe("unsupported_type");
    expect(codeOf(() => validateImageUpload({ size: svg.length, declaredType: "image/png", bytes: svg }))).toBe("type_mismatch");
    expect(codeOf(() => validateImageUpload({ size: JPEG_BYTES.length, declaredType: "image/png", bytes: JPEG_BYTES }))).toBe(
      "type_mismatch",
    );
    expect(codeOf(() => validateImageUpload({ size: 0, declaredType: "image/png", bytes: new Uint8Array() }))).toBe("empty");
    expect(
      codeOf(() => validateImageUpload({ size: UPLOAD_LIMITS.maxBytes + 1, declaredType: "image/png", bytes: PNG_BYTES })),
    ).toBe("too_large");
  });
});

describe("LocalUploadStore", () => {
  it("grava com nome gerado (ignora o original), lista, lê e remove", async () => {
    const { dir, uploads } = await tempUploads();
    const saved = await uploads.save("prod_a", { bytes: PNG_BYTES, size: PNG_BYTES.length, declaredType: "image/png" });
    expect(saved.id).toMatch(/^img_[0-9a-f-]{36}\.png$/);
    expect(saved.uri).toBe(`${dir.replaceAll("\\", "/")}/prod_a/${saved.id}`);
    expect(await readdir(join(dir, "prod_a"))).toEqual([saved.id]);

    expect((await uploads.list("prod_a")).map((i) => i.id)).toEqual([saved.id]);
    expect((await uploads.read("prod_a", saved.id))?.contentType).toBe("image/png");
    expect(await uploads.remove("prod_a", saved.id)).toBe(true);
    expect(await uploads.list("prod_a")).toEqual([]);
    expect(await uploads.remove("prod_a", saved.id)).toBe(false);
  });

  it("respeita o limite de imagens por produto, mesmo com envios simultâneos", async () => {
    const { uploads } = await tempUploads();
    const file = { bytes: JPEG_BYTES, size: JPEG_BYTES.length, declaredType: "image/jpeg" };
    const results = await Promise.allSettled(
      Array.from({ length: UPLOAD_LIMITS.maxImagesPerProduct + 2 }, () => uploads.save("prod_b", file)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(UPLOAD_LIMITS.maxImagesPerProduct);
    const rejected = results.find((r) => r.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: "limit_reached" });
  });

  it("bloqueia path traversal no produto e no nome do arquivo", async () => {
    const { uploads } = await tempUploads();
    const file = { bytes: PNG_BYTES, size: PNG_BYTES.length, declaredType: "image/png" };
    await expect(uploads.save("../evil", file)).rejects.toBeInstanceOf(InvalidUploadPathError);
    await expect(uploads.save("a/b", file)).rejects.toBeInstanceOf(InvalidUploadPathError);
    await expect(uploads.read("prod_a", "../../package.json")).rejects.toBeInstanceOf(InvalidUploadPathError);
    await expect(uploads.remove("prod_a", "img_x.png")).rejects.toBeInstanceOf(InvalidUploadPathError);
    // ID inexistente com formato válido: apenas não existe.
    expect(await uploads.read("prod_a", "img_00000000-0000-0000-0000-000000000000.png")).toBeUndefined();
  });

  it("resolve devolve só imagens existentes, na ordem pedida", async () => {
    const { uploads } = await tempUploads();
    const file = { bytes: PNG_BYTES, size: PNG_BYTES.length, declaredType: "image/png" };
    const a = await uploads.save("prod_c", file);
    const b = await uploads.save("prod_c", file);
    const missing = "img_00000000-0000-0000-0000-000000000000.png";
    expect((await uploads.resolve("prod_c", [b.id, missing, a.id])).map((i) => i.id)).toEqual([b.id, a.id]);
  });
});
