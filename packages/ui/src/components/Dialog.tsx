import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton } from './Button';

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  width = 480,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      style={{ width }}
      className="m-auto max-w-[calc(100vw-2rem)] overflow-visible rounded-lg border border-border bg-canvas-overlay p-0 text-fg shadow-overlay backdrop:bg-black/55 backdrop:backdrop-blur-[2px] open:animate-[pop-enter_220ms_var(--ease-route)_both]"
    >
      {open && (
        <>
          <div className="flex items-center justify-between border-b border-border px-6 py-4">
            <h2 className="text-base font-medium tracking-tight">{title}</h2>
            <IconButton label="Close" icon={<X size={16} />} size="sm" onClick={onClose} />
          </div>
          <div className="px-6 py-6">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-border bg-canvas-subtle px-6 py-4">{footer}</div>}
        </>
      )}
    </dialog>
  );
}
