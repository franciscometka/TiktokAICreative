import Link from "next/link";
import { Card, v2Button } from "./ui";

/**
 * Lote 7: backend fora do ar. Nada técnico (sem ECONNREFUSED, URL interna, SQL ou stack).
 * L8.3: só tokens do DS (text-fg/text-fg-muted) — legível no dark (Home/Create) e na ilha clara.
 */
export function ServiceUnavailable() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16 sm:px-8">
      <Card className="p-8 text-center">
        <p role="alert" className="text-lg font-semibold text-fg">Serviço temporariamente indisponível.</p>
        <p className="mt-2 text-sm text-fg-muted">Seus projetos continuam salvos e os vídeos em produção seguem no servidor. Tente de novo em instantes.</p>
        <Link href="/" className={`${v2Button("secondary")} mt-6`}>Tentar de novo</Link>
      </Card>
    </main>
  );
}

/** Lote 7: telas técnicas antigas que só existem no modo local. */
export function LocalOnly({ title = "Disponível no modo local" }: { title?: string }) {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16 sm:px-8">
      <Card className="p-8 text-center">
        <p className="text-lg font-semibold text-fg">{title}</p>
        <p className="mt-2 text-sm text-fg-muted">Esta tela técnica roda só no modo local. No dia a dia, use Criar vídeo e Projetos.</p>
        <Link href="/projects" className={`${v2Button("secondary")} mt-6`}>Ver projetos</Link>
      </Card>
    </main>
  );
}
