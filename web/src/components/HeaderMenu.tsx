import React, { useEffect, useId, useRef, useState } from 'react';
import { Menu, X } from 'lucide-react';

/** Full-width row inside the small-screen header menu. */
export const headerMenuItem =
  'cf-btn-secondary w-full px-3.5 py-2.5 rounded-xl text-sm flex items-center gap-2 text-left cursor-pointer';

// The actions that do not fit beside the logo on a narrow window.
export const HeaderMenu: React.FC<{
  labelOpen: string;
  labelClose: string;
  closeKey?: string;
  children: React.ReactNode;
}> = ({ labelOpen, labelClose, closeKey, children }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    setOpen(false);
  }, [closeKey]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="md:hidden shrink-0">
      <button
        type="button"
        className="cf-btn-secondary p-2 rounded-xl cursor-pointer"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? labelClose : labelOpen}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <X className="w-4 h-4 text-cf-text" /> : <Menu className="w-4 h-4 text-cf-text" />}
      </button>
      {open && (
        <div
          id={panelId}
          className="absolute inset-x-0 top-full z-40 border-b cf-header px-4 py-4 shadow-[0_18px_40px_-20px_rgba(27,41,33,0.2)]"
        >
          <div className="flex flex-col gap-2.5">{children}</div>
        </div>
      )}
    </div>
  );
};
