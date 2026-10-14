/**
 * Setup do `npm test`: qualquer `fetch` para fora de 127.0.0.1/localhost falha na hora.
 * Garante que nenhum teste normal chama ElevenLabs/Anthropic/qualquer API (custo zero, offline).
 * Providers recebem transporte falso nos testes; se algum esquecer, o teste quebra aqui.
 */
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`Rede bloqueada nos testes: tentativa de acessar ${host}`);
  }
  return realFetch(input, init);
}) as typeof fetch;
