import { SAFE_PRODUCT_ID, STORED_IMAGE_NAME } from "@/domain/upload";
import { getRuntime } from "@/server/runtime";
import { cloudAssetRedirect } from "@/server/asset-redirect";
import { runtimeMode } from "@/server/session";

export const runtime = "nodejs";

/**
 * Serve SOMENTE imagens geradas pelo upload: productId e nome do arquivo precisam bater com os
 * padrões do sistema, e o store ainda confere que o caminho fica dentro da pasta de uploads.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ productId: string; file: string }> }) {
  const { productId, file } = await ctx.params;
  if (!SAFE_PRODUCT_ID.test(productId) || !STORED_IMAGE_NAME.test(file)) {
    return new Response("Not found", { status: 404 });
  }
  if (runtimeMode() === "cloud") return cloudAssetRedirect({ kind: "upload", ownerId: productId, imageId: file });
  const image = await getRuntime().deps.uploads.read(productId, file);
  if (!image) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(image.bytes), {
    headers: {
      "Content-Type": image.contentType,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
