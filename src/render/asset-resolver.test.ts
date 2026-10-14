import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makePng } from "@/test/png";
import { AssetCorruptedError, AssetResolver, AssetSecurityError } from "./asset-resolver";
import { imageDimensions } from "./image-dimensions";

let cwd: string;
let resolver: AssetResolver;

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "asset-resolver-"));
  await mkdir(join(cwd, "data/uploads/prod_1"), { recursive: true });
  await writeFile(join(cwd, "data/uploads/prod_1/img_a.png"), makePng(40, 60));
  await writeFile(join(cwd, "data/uploads/prod_1/fake.png"), "isto não é png");
  await writeFile(join(cwd, "data/secret.png"), makePng(10, 10));
  resolver = new AssetResolver(["data/uploads"], cwd);
});

afterAll(() => rm(cwd, { recursive: true, force: true }));

describe("AssetResolver", () => {
  it("mock:// vira placeholder sem tocar no disco", async () => {
    expect(await resolver.resolve("mock://video/1.mp4")).toEqual({ kind: "mock", uri: "mock://video/1.mp4" });
  });

  it("resolve imagem autorizada com tipo e dimensões reais", async () => {
    const r = await resolver.resolve("data/uploads/prod_1/img_a.png");
    expect(r).toMatchObject({ kind: "file", contentType: "image/png", size: { width: 40, height: 60 } });
  });

  it("arquivo autorizado mas inexistente → missing (vira aviso, não erro)", async () => {
    expect(await resolver.resolve("data/uploads/prod_1/nao-existe.png")).toEqual({ kind: "missing", uri: "data/uploads/prod_1/nao-existe.png" });
  });

  it.each([
    ["path traversal", "data/uploads/../secret.png"],
    ["traversal profundo", "data/uploads/prod_1/../../../../etc/passwd.png"],
    ["fora das raízes", "data/secret.png"],
    ["caminho absoluto posix", "/etc/passwd.png"],
    ["caminho absoluto windows", "C:\\Windows\\win.ini.png"],
    ["caminho UNC", "\\\\servidor\\share\\a.png"],
    ["URL http", "http://example.com/a.png"],
    ["file://", "file:///etc/a.png"],
    ["caractere nulo", "data/uploads/prod_1/img_a.png\0.txt"],
    ["prefixo parecido com a raiz", "data/uploads-evil/a.png"],
    ["extensão não-imagem", "data/uploads/prod_1/notes.txt"],
  ])("recusa %s", async (_label, uri) => {
    await expect(resolver.resolve(uri)).rejects.toBeInstanceOf(AssetSecurityError);
  });

  it("conteúdo que não é imagem → AssetCorruptedError", async () => {
    await expect(resolver.resolve("data/uploads/prod_1/fake.png")).rejects.toBeInstanceOf(AssetCorruptedError);
  });

  it("exige ao menos uma raiz", () => {
    expect(() => new AssetResolver([], cwd)).toThrow();
  });
});

describe("imageDimensions", () => {
  it("lê PNG", () => {
    expect(imageDimensions(makePng(123, 45), "image/png")).toEqual({ width: 123, height: 45 });
  });

  it("lê JPEG (SOF0)", () => {
    const jpeg = Buffer.from([
      0xff, 0xd8, // SOI
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0 curto
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]);
    expect(imageDimensions(jpeg, "image/jpeg")).toEqual({ width: 800, height: 600 });
  });

  it("lê WebP VP8X", () => {
    const b = Buffer.alloc(30);
    b.write("RIFF", 0, "ascii");
    b.write("WEBPVP8X", 8, "ascii");
    b.writeUIntLE(1080 - 1, 24, 3);
    b.writeUIntLE(1920 - 1, 27, 3);
    expect(imageDimensions(b, "image/webp")).toEqual({ width: 1080, height: 1920 });
  });

  it("cabeçalho truncado ou tipo desconhecido → undefined", () => {
    expect(imageDimensions(Buffer.alloc(10), "image/png")).toBeUndefined();
    expect(imageDimensions(makePng(2, 2), "image/gif")).toBeUndefined();
  });
});
