import { useId, useState } from 'react';

// Состояние одного пояснения за «?» (components/Help.jsx)
export function useHelp() {
  const id = useId();
  const [open, setOpen] = useState(false);
  return { id, open, toggle: () => setOpen((v) => !v), close: () => setOpen(false) };
}
