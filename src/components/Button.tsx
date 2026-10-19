import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-accent text-on-accent hover:brightness-110 disabled:opacity-50 font-medium",
  secondary:
    "bg-bg border border-border text-text hover:bg-hover disabled:opacity-50",
  ghost: "text-text-2 hover:bg-hover hover:text-text disabled:opacity-50",
  // Red is reserved for « Claude attend » (D8): a destructive confirmation is plain dark.
  danger: "bg-text text-bg hover:opacity-90 disabled:opacity-50 font-medium",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md";
}

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  type = "button",
  ...props
}: ButtonProps) {
  const sizing =
    size === "sm" ? "h-7 px-2.5 text-[13px]" : "h-8 px-3 text-[13.5px]";
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md whitespace-nowrap transition-colors ${sizing} ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}

export interface IconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: icon buttons always carry an accessible name. */
  label: string;
  children: ReactNode;
  size?: number;
}

export function IconButton({
  label,
  children,
  size = 28,
  className = "",
  type = "button",
  title,
  ...props
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={title ?? label}
      style={{ width: size, height: size }}
      className={`inline-flex shrink-0 items-center justify-center rounded-md text-text-2 transition-colors hover:bg-hover hover:text-text disabled:opacity-40 disabled:hover:bg-transparent ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
