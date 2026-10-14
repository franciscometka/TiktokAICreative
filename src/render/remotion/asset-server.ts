import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Servidor HTTP efêmero (127.0.0.1, porta aleatória) que entrega ao Chrome do Remotion SÓ os
 * arquivos já autorizados pelo AssetResolver, por token aleatório. Evita copiar uploads para o
 * bundle e nunca expõe um caminho: URLs desconhecidas → 404. Vive só durante um render.
 */
export interface AssetServer {
  urlFor(uri: string): string;
  close(): Promise<void>;
}

export async function startAssetServer(
  files: ReadonlyMap<string, { absolutePath: string; contentType: string }>,
): Promise<AssetServer> {
  const byToken = new Map<string, { absolutePath: string; contentType: string }>();
  const tokenByUri = new Map<string, string>();
  for (const [uri, file] of files) {
    const token = randomUUID();
    byToken.set(token, file);
    tokenByUri.set(uri, token);
  }

  const server: Server = createServer((req, res) => {
    const match = /^\/assets\/([0-9a-f-]{36})$/.exec(req.url ?? "");
    const file = match?.[1] ? byToken.get(match[1]) : undefined;
    if (req.method !== "GET" || !file) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": file.contentType, "Cache-Control": "no-store" });
    createReadStream(file.absolutePath)
      .on("error", () => res.destroy())
      .pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    urlFor(uri) {
      const token = tokenByUri.get(uri);
      if (!token) throw new Error(`Asset não registrado no servidor de render: ${uri}`);
      return `http://127.0.0.1:${port}/assets/${token}`;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
