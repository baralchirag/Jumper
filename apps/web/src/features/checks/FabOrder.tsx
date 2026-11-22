import { ExternalLink } from 'lucide-react';
import { FAB_ORDER_PAGES, FAB_PACKAGE_LABELS } from '@jumper/shared';
import { cx } from '@jumper/ui';

type Fab = 'jlcpcb' | 'pcbway' | 'oshpark';
export const isOrderableFab = (f: unknown): f is Fab => f === 'jlcpcb' || f === 'pcbway' || f === 'oshpark';

/** "Order from JLCPCB" next to a fab package. */
export function FabOrderLink({ fab, className }: { fab: Fab; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-[13px]', className)}>
      <a href={FAB_ORDER_PAGES[fab]} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-1">
        Order from {FAB_PACKAGE_LABELS[fab]} <ExternalLink size={12} />
      </a>
    </span>
  );
}
