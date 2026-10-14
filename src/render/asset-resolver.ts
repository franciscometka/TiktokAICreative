import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { detectImageType, type ImageContentType } from "@/domain/upload";
import { imageDimensions, type ImageSize } from "./image-dimensions";

/**
 * Resolve as URIs do RenderManifest para arquivos locais AUTORIZADOS. Três desfechos:
 * - "mock": asset simulado (mock://) → a composição usa placeholder; nunca é aberto como arquivo.
 * - "file": arquivo dentro de uma raiz permitida, com conteúdo conferido.
 * - "missing": caminho válido e autorizado, mas o arquivo não existe (vira warning).
 * Caminho fora das raízes, absoluto, com esquema (http:, file:, C:) ou conteúdo que não bate
 * com o tipo é ERRO (AssetSecurityError / AssetCorruptedError): nunca é escondido como warning.
 */

export type ResolvedAsset =
  | { kind: "mock"; uri: string }
  | { kind: "file"; uri: string; absolutePath: string; contentType: ImageContentType; size: ImageSize }
  | { kind: "missing"; uri: string };

export class AssetSecurityError extends Error {
  override name = "AssetSecurityError";
}

export class AssetCorruptedError extends Error {
  override name = "AssetCorruptedError";
}

const MOCK_SCHEME = "mock://";
const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const IMAGE_EXTENSION = /\.(jpe?g|png|webp)$/i;

export class AssetResolver {
  private readonly roots: string[];

  /** `allowedRoots`: pastas (relativas ao cwd ou absolutas) de onde assets podem ser lidos. */
  constructor(
    allowedRoots: readonly string[],
    private readonly cwd: string = process.cwd(),
  ) {
    if (allowedRoots.length === 0) throw new Error("AssetResolver precisa de ao menos uma raiz permitida");
    this.roots = allowedRoots.map((r) => resolve(cwd, r));
  }

  /** Valida o caminho SEM tocar no disco. Lança AssetSecurityError. */
  authorize(uri: string): string {
    if (uri.includes("\0")) throw new AssetSecurityError("URI de asset com caractere nulo");
    if (isAbsolute(uri) || HAS_SCHEME.test(uri) || uri.startsWith("\\\\")) {
      throw new AssetSecurityError(`URI de asset não permitida: ${JSON.stringify(uri.slice(0, 80))}`);
    }
    const full = resolve(this.cwd, uri);
    if (!this.roots.some((root) => full.startsWith(root + sep))) {
      throw new AssetSecurityError("Asset fora das pastas autorizadas");
    }
    if (!IMAGE_EXTENSION.test(full)) throw new AssetSecurityError("Tipo de asset não suportado");
    return full;
  }

  async resolve(uri: string): Promise<ResolvedAsset> {
    if (uri.startsWith(MOCK_SCHEME)) return { kind: "mock", uri };
    const absolutePath = this.authorize(uri);
    let bytes: Buffer;
    try {
      bytes = await readFile(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing", uri };
      throw error;
    }
    const contentType = detectImageType(bytes);
    if (!contentType) throw new AssetCorruptedError(`Arquivo não é uma imagem válida: ${uri}`);
    const size = imageDimensions(bytes, contentType);
    if (!size) throw new AssetCorruptedError(`Não foi possível ler as dimensões da imagem: ${uri}`);
    return { kind: "file", uri, absolutePath, contentType, size };
  }
}
