import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from '../cx';
import { Spinner } from './Spinner';

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'invisible' | 'accent';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  block?: boolean;
}

/*
 * primary: ink plate, the default "do it" action.
 * accent:  signal yellow with dark text, at most one per view (create, start, download fab package).
 * default: hairline outline on the surface.
 */
const variants: Record<ButtonVariant, string> = {
  default: 'bg-canvas text-fg border-border hover:border-fg-subtle hover:bg-canvas-subtle',
  primary: 'bg-fg text-canvas border-transparent hover:bg-accent-emphasis hover:text-fg-on-accent',
  accent: 'bg-accent-emphasis text-fg-on-accent border-transparent hover:bg-fg hover:text-canvas',
  danger: 'bg-canvas text-danger border-border hover:bg-danger-emphasis hover:text-fg-on-emphasis hover:border-danger-emphasis',
  invisible: 'bg-transparent text-fg-muted border-transparent hover:bg-neutral-muted hover:text-fg',
};

export function buttonClass(variant: ButtonVariant = 'default', size: ButtonSize = 'md', extra?: string) {
  return cx(
    'group/btn inline-flex items-center justify-center gap-1.5 rounded-sm border font-medium whitespace-nowrap select-none no-underline',
    'transition-[background-color,border-color,color,translate] duration-200 ease-[var(--ease-route)] active:translate-y-px',
    'disabled:opacity-45 disabled:pointer-events-none',
    size === 'sm' ? 'h-8 px-3 text-[13px]' : 'h-10 px-4 text-sm',
    variants[variant],
    extra,
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', loading, leadingIcon, trailingIcon, block, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass(variant, size, cx(block && 'w-full', className))}
      {...rest}
    >
      {loading ? <Spinner size={14} /> : leadingIcon}
      {children}
      {trailingIcon}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = 'invisible', size = 'md', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={buttonClass(variant, size, cx(size === 'sm' ? 'w-8 px-0!' : 'w-10 px-0!', '[&>svg]:shrink-0', className))}
      {...rest}
    >
      {icon}
    </button>
  );
});
