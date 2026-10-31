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
      className="m-auto max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-canvas-overlay p-0 text-fg shadow-overlay backdrop:bg-black/40"
    >
      {open && (
        <>
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-base font-semibold">{title}</h2>
            <IconButton label="Close" icon={<X size={16} />} size="sm" onClick={onClose} />
          </div>
          <div className="px-4 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-border px-4 py-3">{footer}</div>}
        </>
      )}
    </dialog>
  );
}
