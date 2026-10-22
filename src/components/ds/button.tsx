import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Spinner } from "./spinner";
import { cx, focusRing, interactive, type Size } from "./styles";

/**
 * Button: primary (violeta sólido), secondary (superfície + borda), ghost, danger e `ai`
 * (gradiente da marca — SÓ para o CTA especial de IA). `buttonClass` serve para <Link>.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "ai";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-primary text-on-primary shadow-[inset_0_1px_0_rgb(255_255_255/0.18),0_1px_2px_rgb(0_0_0/0.35)] hover:bg-primary-hover",
  secondary: "bg-surface text-fg ring-1 ring-inset ring-line-strong hover:bg-surface-hover hover:ring-fg-subtle/40",
  ghost: "text-fg-muted hover:bg-surface-hover hover:text-fg",
  danger: "bg-danger-soft text-danger ring-1 ring-inset ring-danger/25 hover:bg-danger/20",
  ai: cx(
    "relative isolate overflow-hidden bg-(image:--cf-gradient-ai) text-on-primary",
    "shadow-[inset_0_1px_0_rgb(255_255_255/0.22),0_10px_28px_-10px_rgb(124_58_237/0.75)]",
    "before:absolute before:inset-0 before:-z-10 before:bg-white/0 before:transition-colors before:duration-(--dur-fast) hover:before:bg-white/10",
  ),
};

const SIZE: Record<Size, string> = {
  sm: "h-8 gap-1.5 rounded-lg px-3 text-[13px] [&_svg]:size-3.5",
  md: "h-10 gap-2 rounded-[10px] px-4 text-sm [&_svg]:size-4",
  lg: "h-12 gap-2.5 rounded-xl px-6 text-[15px] [&_svg]:size-[18px]",
};

export function buttonClass({ variant = "primary", size = "md", block = false }: { variant?: ButtonVariant; size?: Size; block?: boolean } = {}): string {
  return cx(
    "inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap",
    interactive, focusRing,
    "active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45",
    VARIANT[variant], SIZE[size], block && "w-full",
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: Size;
  block?: boolean;
  /** Mostra spinner, bloqueia o clique e anuncia `aria-busy`. O texto continua visível. */
  loading?: boolean;
  icon?: ReactNode;
  trailingIcon?: ReactNode;
}

export function Button({ variant, size, block, loading = false, icon, trailingIcon, className, children, disabled, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} className={cx(buttonClass({ variant, size, block }), className)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Spinner /> : icon}
      {children}
      {trailingIcon}
    </button>
  );
}

const ICON_SIZE: Record<Size, string> = {
  sm: "size-8 rounded-lg [&_svg]:size-4",
  md: "size-10 rounded-[10px] [&_svg]:size-[18px]",
  lg: "size-12 rounded-xl [&_svg]:size-5",
};

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  /** Obrigatório: botão só com ícone precisa de nome acessível. */
  label: string;
  variant?: Exclude<ButtonVariant, "ai">;
  size?: Size;
  selected?: boolean;
}

export function IconButton({ label, variant = "ghost", size = "md", selected, className, children, type = "button", ...rest }: IconButtonProps) {
  return (
    <button type={type} aria-label={label} title={label} aria-pressed={selected}
      className={cx(
        "inline-flex shrink-0 items-center justify-center", interactive, focusRing,
        "active:scale-[0.94] disabled:pointer-events-none disabled:opacity-45",
        VARIANT[variant], ICON_SIZE[size],
        selected && "bg-primary-soft text-primary-light hover:bg-primary-soft",
        className,
      )} {...rest}>
      {children}
    </button>
  );
}
