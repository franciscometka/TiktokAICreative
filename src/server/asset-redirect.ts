import { apiFetch, ServiceUnavailableError } from "./backend";
import { accessToken } from "./session";

/**
 * Lote 7 (modo cloud): as rotas de arquivo do Next não leem disco nem baixam vídeo. Pedem à
 * Render API uma URL assinada de vida curta (só para arquivo registrado do próprio usuário) e
 * redirecionam o browser direto ao Storage. Nada de URL assinada fica salva.
 */
export async function cloudAssetRedirect(query: Record<string, string>): Promise<Response> {
  const token = await accessToken();
  if (!token) return new Response("Unauthorized", { status: 401 });
  try {
    const { status, json } = await apiFetch<{ ok: boolean; value?: { url: string } }>(token, "GET", `/v1/assets/signed?${new URLSearchParams(query)}`);
    if (status !== 200 || !json.ok || !json.value) return new Response("Not found", { status: 404 });
    return new Response(null, { status: 302, headers: { Location: json.value.url, "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
  } catch (error) {
    if (error instanceof ServiceUnavailableError) return new Response("Serviço temporariamente indisponível.", { status: 503 });
    throw error;
  }
}
