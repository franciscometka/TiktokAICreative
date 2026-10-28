/**
 * Timestamps do domínio são strings ISO geradas pelo clock do servidor. Para as colunas
 * `timestamptz`, aceita só data válida; qualquer outra coisa (dado antigo/teste) vira "agora" —
 * o valor original continua intacto dentro do documento JSON.
 */
export function timestamp(value: string | undefined): string {
  return value && !Number.isNaN(Date.parse(value)) ? value : new Date().toISOString();
}
