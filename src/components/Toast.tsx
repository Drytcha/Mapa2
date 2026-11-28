import { useEffect } from "react";
import { Check, X } from "lucide-react";

export function Toast({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, 3400);
    return () => window.clearTimeout(timer);
  }, [message, onClose]);

  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[4000] -translate-x-1/2 animate-rise-in">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-2 shadow-[0_12px_34px_rgba(0,0,0,0.18)]">
        <span className="grid h-4 w-4 place-items-center rounded-full bg-brand-soft text-brand-ink">
          <Check className="h-2.5 w-2.5" strokeWidth={3} />
        </span>
        <span className="text-[10.5px] font-bold text-ink">{message}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Zamknij"
          className="ml-1 text-mute hover:text-ink"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
