import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

/**
 * Resposta HTTP de um arquivo JÁ resolvido e validado no servidor (nunca um caminho do browser).
 * Suporta Range (206/416) para <video>/<audio> buscarem posição e mostrarem a duração.
 */
export function serveFile(
  request: Request,
  file: { absolutePath: string; sizeBytes: number; fileName: string },
  contentType: string,
): Response {
  const download = new URL(request.url).searchParams.get("download") === "1";
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-cache",
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${file.fileName}"`,
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    const size = file.sizeBytes;
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    const stream = Readable.toWeb(createReadStream(file.absolutePath, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }

  const stream = Readable.toWeb(createReadStream(file.absolutePath)) as ReadableStream;
  return new Response(stream, { headers: { ...headers, "Content-Length": String(file.sizeBytes) } });
}
