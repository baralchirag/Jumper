import { ExternalLink } from 'lucide-react';
import { FAB_PACKAGE_LABELS } from '@jumper/shared';
import { cx } from '@jumper/ui';
import { useSite } from '../legal/Legal';

type Fab = 'jlcpcb' | 'pcbway' | 'oshpark';
export const isOrderableFab = (f: unknown): f is Fab => f === 'jlcpcb' || f === 'pcbway' || f === 'oshpark';

/** "Order from JLCPCB" next to a fab package. Operator referral links are marked as such. */
export function FabOrderLink({ fab, className }: { fab: Fab; className?: string }) {
  const site = useSite();
  const link = site.data?.fabLinks?.[fab];
  if (!link) return null;
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-[13px]', className)}>
      <a href={link.url} target="_blank" rel={link.referral ? 'noopener sponsored' : 'noopener noreferrer'} className="link inline-flex items-center gap-1">
        Order from {FAB_PACKAGE_LABELS[fab]} <ExternalLink size={12} />
      </a>
      {link.referral && <span className="text-xs text-fg-subtle" title="This instance may earn credit when you order through this link.">referral link</span>}
    </span>
  );
}
