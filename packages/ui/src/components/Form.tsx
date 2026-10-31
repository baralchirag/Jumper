import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cx } from '../cx';

const field =
  'w-full rounded-md border border-border bg-canvas px-3 text-sm text-fg placeholder:text-fg-subtle shadow-subtle ' +
  'focus:border-accent-emphasis focus:outline-none focus:ring-2 focus:ring-accent-muted disabled:bg-canvas-subtle disabled:text-fg-muted';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input(
  { className, invalid, ...rest },
  ref,
) {
  return <input ref={ref} className={cx(field, 'h-8', invalid && 'border-danger', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, rows = 6, ...rest },
  ref,
) {
  return <textarea ref={ref} rows={rows} className={cx(field, 'py-2 leading-normal', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={cx(field, 'h-8 pr-8 appearance-auto', className)} {...rest}>
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
    <div className={cx('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-sm font-semibold text-fg">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </label>
      {children(id)}
      {hint && !error && <p className="text-xs text-fg-muted">{hint}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

export function Checkbox({ label, hint, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="flex gap-2">
      <input id={id} type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--pcb-accent-emphasis)]" {...rest} />
      <label htmlFor={id} className="text-sm">
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-xs text-fg-muted">{hint}</span>}
      </label>
    </div>
  );
}
