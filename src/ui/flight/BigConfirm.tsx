import { type ReactNode, useEffect, useState } from "react";

import styles from "./BigConfirm.module.css";

interface Pending {
  title: string;
  action: string;
  onAction: () => void;
}

/**
 * The in-flight dialog surface: plain DOM, no Ionic. FlyPage is almost a
 * separate app (Ionic leaves the live surface entirely one day), and the
 * Ionic alert was the wrong shape for it anyway: a gloved hand over
 * turbulence gets dialog-sized targets, phone-alert ones are a mistap
 * machine. Big type, two big buttons, solid surfaces for sunlight.
 * Shared by the end-flight confirm (useBigConfirm) and FlyPage's landing
 * prompt — one dialog language in flight, one DOM shape.
 */
export function ConfirmSurface({
  title,
  cancelLabel,
  action,
  onCancel,
  onAction,
  scrimTestId,
}: {
  title: string;
  cancelLabel: string;
  action: ReactNode;
  // The scrim and the left button are BOTH the safe answer.
  onCancel: () => void;
  onAction: () => void;
  scrimTestId?: string;
}) {
  return (
    <div
      className={styles.scrim}
      role="presentation"
      data-testid={scrimTestId}
      onClick={onCancel}
    >
      <div
        className={styles.panel}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.title}>{title}</div>
        <div className={styles.actions}>
          <button className={styles.cancel} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className={styles.action} onClick={onAction}>
            {action}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The imperative end-flight confirm: the scrim and Escape cancel; only
 * the named action acts.
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
    <ConfirmSurface
      title={pending.title}
      cancelLabel="Cancel"
      action={pending.action}
      onCancel={close}
      onAction={() => {
        setPending(null);
        pending.onAction();
      }}
    />
  ) : null;

  return { confirm: setPending, element };
}
