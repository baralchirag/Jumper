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

const variants: Record<ButtonVariant, string> = {
  default: 'bg-canvas-subtle text-fg border-border hover:bg-canvas-inset',
  primary: 'bg-success-emphasis text-fg-on-emphasis border-black/10 hover:brightness-95',
  accent: 'bg-accent-emphasis text-fg-on-emphasis border-black/10 hover:brightness-95',
  danger: 'bg-canvas-subtle text-danger border-border hover:bg-danger-emphasis hover:text-fg-on-emphasis hover:border-danger-emphasis',
  invisible: 'bg-transparent text-fg-muted border-transparent hover:bg-neutral-muted hover:text-fg',
};

export function buttonClass(variant: ButtonVariant = 'default', size: ButtonSize = 'md', extra?: string) {
  return cx(
    'inline-flex items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap select-none transition-colors',
    'disabled:opacity-50 disabled:pointer-events-none shadow-subtle',
    size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
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
      className={buttonClass(variant, size, cx(size === 'sm' ? 'w-7 px-0' : 'w-8 px-0', className))}
      {...rest}
    >
      {icon}
    </button>
  );
});
