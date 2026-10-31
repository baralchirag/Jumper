import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { IconButton } from './Button';

export function CopyButton({ value, label = 'Copy', size = 'sm' }: { value: string; label?: string; size?: 'sm' | 'md' }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={done ? 'Copied' : label}
      size={size}
      variant="default"
      icon={done ? <Check size={14} className="text-success" /> : <Copy size={14} />}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    />
  );
}
