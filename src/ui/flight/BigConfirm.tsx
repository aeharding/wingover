import { type ReactNode, useEffect, useState } from "react";

import "./BigConfirm.css";

interface Pending {
  title: string;
  action: string;
  onAction: () => void;
}

/**
 * The in-flight confirm: plain DOM, no Ionic. FlyPage is almost a
 * separate app (Ionic leaves the live surface entirely one day), and the
 * Ionic alert was the wrong shape for it anyway: a gloved hand over
 * turbulence gets dialog-sized targets, phone-alert ones are a mistap
 * machine. Big type, two big buttons, solid surfaces for sunlight. The
 * scrim and Escape cancel; only the named action acts.
 */
export function useBigConfirm(): {
  confirm: (options: Pending) => void;
  element: ReactNode;
} {
  const [pending, setPending] = useState<Pending | null>(null);
  const close = () => setPending(null);

  useEffect(() => {
    if (!pending) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPending(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending]);

  const element = pending ? (
    <div className="big-confirm" role="presentation" onClick={close}>
      <div
        className="big-confirm-panel"
        role="alertdialog"
        aria-modal="true"
        aria-label={pending.title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="big-confirm-title">{pending.title}</div>
        <div className="big-confirm-actions">
          <button className="big-confirm-cancel" onClick={close}>
            Cancel
          </button>
          <button
            className="big-confirm-action"
            onClick={() => {
              setPending(null);
              pending.onAction();
            }}
          >
            {pending.action}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm: setPending, element };
}
