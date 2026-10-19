/**
 * Modal dialog shell,
 * plus promise-based `confirmDialog` and `promptDialog` rendered by <DialogHost />.
 */

import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { create } from "zustand";
import { fr } from "../i18n/fr";
import { errorMessage } from "../lib/ipc";
import { readableError } from "../lib/run";
import { Button } from "./Button";

export interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  /** Hides the visible title (it stays the accessible name). */
  hideTitle?: boolean;
  /** A click outside closes it (default); `false` for a screen that must be left on purpose. */
  closeOnBackdrop?: boolean;
}

export function Dialog({
  title,
  onClose,
  children,
  width = 440,
  hideTitle = false,
  closeOnBackdrop = true,
}: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const first =
      ref.current?.querySelector<HTMLElement>("[data-autofocus]") ??
      ref.current?.querySelector<HTMLElement>(
        "input, textarea, select, button",
      );
    first?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
    if (e.key === "Tab" && ref.current) {
      // Keep the focus inside the dialog.
      const focusables = Array.from(
        ref.current.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), textarea, select, [tabindex='0']",
        ),
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking the backdrop closes; Escape is handled by the dialog
    <div
      className="fixed inset-0 z-40 flex justify-center bg-overlay"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="mt-[120px] h-fit max-h-[calc(100vh-160px)] overflow-auto rounded-xl border border-border bg-elevated shadow-pop"
        style={{ width, maxWidth: "calc(100vw - 32px)" }}
      >
        <h2
          id={titleId}
          className={
            hideTitle ? "sr-only" : "px-5 pt-4 text-[16px] font-semibold"
          }
        >
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// confirm / prompt
// ---------------------------------------------------------------------------

export interface PromptField {
  name: string;
  label: string;
  initial?: string;
  placeholder?: string;
  mono?: boolean;
  required?: boolean;
  help?: string;
}

type Pending =
  | {
      kind: "confirm";
      title: string;
      message: string;
      confirmLabel: string;
      danger: boolean;
      resolve: (ok: boolean) => void;
    }
  | {
      kind: "prompt";
      title: string;
      fields: PromptField[];
      confirmLabel: string;
      submit?: PromptSubmit;
      resolve: (values: Record<string, string> | null) => void;
    };

/**
 * Runs the command of a prompt while the dialog stays open. On failure the dialog keeps the
 * typed values and shows the error under the fields (`action`: first half of the text).
 */
export interface PromptSubmit {
  run: (values: Record<string, string>) => Promise<unknown>;
  action?: string;
}

const useDialogStore = create<{ pending: Pending | null }>(() => ({
  pending: null,
}));

export function confirmDialog(options: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogStore.setState({
      pending: {
        kind: "confirm",
        title: options.title,
        message: options.message,
        confirmLabel: options.confirmLabel ?? fr.common.delete,
        danger: options.danger ?? true,
        resolve,
      },
    });
  });
}

/**
 * Asks for values. With `submit`, the command runs before the dialog closes: the promise
 * resolves with the values once it succeeded, or `null` when the user cancels.
 */
export function promptDialog(options: {
  title: string;
  fields: PromptField[];
  confirmLabel?: string;
  submit?: PromptSubmit;
}): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    useDialogStore.setState({
      pending: {
        kind: "prompt",
        title: options.title,
        fields: options.fields,
        confirmLabel: options.confirmLabel ?? fr.common.save,
        submit: options.submit,
        resolve,
      },
    });
  });
}

export function isPromiseDialogOpen(): boolean {
  return useDialogStore.getState().pending !== null;
}

function PromptForm({
  pending,
  done,
}: {
  pending: Extract<Pending, { kind: "prompt" }>;
  done: (values: Record<string, string> | null) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(pending.fields.map((f) => [f.name, f.initial ?? ""])),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = useId();
  const valid = pending.fields.every(
    (f) => !f.required || (values[f.name] ?? "").trim().length > 0,
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    if (!pending.submit) {
      done(values);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await pending.submit.run(values);
    } catch (err) {
      console.error(errorMessage(err), err);
      setError(readableError(err, pending.submit.action));
      setBusy(false);
      return;
    }
    done(values);
  };
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-3 px-5 pt-3 pb-4"
    >
      {pending.fields.map((f) => (
        <label key={f.name} className="flex flex-col gap-1">
          <span className="text-[12px] text-text-2">{f.label}</span>
          <input
            value={values[f.name] ?? ""}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            placeholder={f.placeholder}
            onChange={(e) =>
              setValues((v) => ({ ...v, [f.name]: e.target.value }))
            }
            className={`h-9 rounded-md border border-border bg-bg px-2.5 text-[14px] outline-none focus:border-accent ${
              f.mono ? "font-mono text-[12.5px]" : ""
            }`}
          />
          {f.help && <span className="text-[12px] text-text-3">{f.help}</span>}
        </label>
      ))}
      {error && (
        <p
          id={errorId}
          role="alert"
          className="text-[12.5px] font-medium text-text"
        >
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button onClick={() => done(null)}>{fr.common.cancel}</Button>
        <Button type="submit" variant="primary" disabled={!valid || busy}>
          {pending.confirmLabel}
        </Button>
      </div>
    </form>
  );
}

export function DialogHost() {
  const pending = useDialogStore((s) => s.pending);
  if (!pending) return null;

  if (pending.kind === "confirm") {
    const done = (ok: boolean) => {
      useDialogStore.setState({ pending: null });
      pending.resolve(ok);
    };
    return (
      <Dialog title={pending.title} onClose={() => done(false)} width={420}>
        <p className="px-5 pt-2 text-[13.5px] text-text-2">{pending.message}</p>
        <div className="flex justify-end gap-2 px-5 pt-4 pb-4">
          <Button onClick={() => done(false)}>{fr.common.cancel}</Button>
          <Button
            variant={pending.danger ? "danger" : "primary"}
            onClick={() => done(true)}
            data-autofocus
          >
            {pending.confirmLabel}
          </Button>
        </div>
      </Dialog>
    );
  }

  const done = (values: Record<string, string> | null) => {
    useDialogStore.setState({ pending: null });
    pending.resolve(values);
  };
  return (
    <Dialog title={pending.title} onClose={() => done(null)}>
      <PromptForm pending={pending} done={done} />
    </Dialog>
  );
}
