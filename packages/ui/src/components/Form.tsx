import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cx } from '../cx';

/** Fields fill their container unless a width class is passed (CSS order would otherwise let w-full beat w-32). */
const widthOf = (className?: string) => (className && /(^|\s)(w|min-w|max-w)-/.test(className) ? undefined : 'w-full');

const field =
  'rounded-sm border border-border bg-canvas px-3.5 text-sm text-fg placeholder:text-fg-subtle ' +
  'transition-[border-color,box-shadow] duration-200 hover:border-fg-subtle/60 ' +
  'focus:border-select focus:outline-none focus:shadow-[0_0_0_3px_var(--pcb-accent-subtle)] ' +
  'aria-[invalid=true]:border-danger disabled:bg-canvas-subtle disabled:text-fg-muted';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input(
  { className, invalid, ...rest },
  ref,
) {
  return <input ref={ref} aria-invalid={invalid || undefined} className={cx(field, widthOf(className), 'h-10', invalid && 'border-danger', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, rows = 6, ...rest },
  ref,
) {
  return <textarea ref={ref} rows={rows} className={cx(field, widthOf(className), 'py-2 leading-normal', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={cx(field, widthOf(className), 'h-10 pr-8 appearance-auto', className)} {...rest}>
      {children}
    </select>
  );
});

export interface FormFieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: (id: string) => ReactNode;
  className?: string;
}

export function FormField({ label, hint, error, required, children, className }: FormFieldProps) {
  const id = useId();
  return (
    <div className={cx('space-y-2', className)}>
      <label htmlFor={id} className="block text-sm font-medium text-fg">
        {label}
        {required && (
          <span className="ml-1 text-accent" aria-hidden>
            *
          </span>
        )}
      </label>
      {children(id)}
      {hint && !error && <p className="text-[13px] leading-snug text-fg-muted">{hint}</p>}
      {error && (
        <p className="flex items-center gap-1.5 text-xs text-danger">
          <span aria-hidden className="h-1.5 w-1.5 rotate-45 bg-danger" />
          {error}
        </p>
      )}
    </div>
  );
}

export function Checkbox({ label, hint, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="flex gap-3">
      <input id={id} type="checkbox" className="mt-0.5 h-[18px] w-[18px] rounded-none accent-[var(--pcb-accent-emphasis)]" {...rest} />
      <label htmlFor={id} className="text-sm">
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-xs text-fg-muted">{hint}</span>}
      </label>
    </div>
  );
}
