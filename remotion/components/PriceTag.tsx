import { COLORS, FONT, TYPE } from "../styles/theme";

/** Preço já formatado em pt-BR pelo app (ex.: "R$ 79,90"). Nunca formatado aqui. */
export function PriceTag({ label }: { label: string }) {
  return (
    <span
      style={{
        color: COLORS.white,
        fontFamily: FONT.family,
        fontSize: TYPE.price.size,
        lineHeight: TYPE.price.lineHeight,
        letterSpacing: TYPE.price.tracking,
        fontWeight: TYPE.price.weight,
      }}
    >
      {label}
    </span>
  );
}
