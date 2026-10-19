import { useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { fr } from "../../i18n/fr";
import { errorMessage } from "../../lib/ipc";

const COPIED_MS = 1500;

/** A sentence or a command to type, selectable, with « Copier ». */
export function PromptBox({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(true))
      .catch((error) => console.error(errorMessage(error), error));
  };

  return (
    <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-bg py-1.5 pr-1.5 pl-2.5">
      <code className="min-w-0 flex-1 font-mono text-[12.5px] leading-[18px] text-text select-text">
        {text}
      </code>
      <Button size="sm" onClick={copy} aria-live="polite">
        {copied ? fr.tutorial.talk.copied : fr.tutorial.talk.copy}
      </Button>
    </div>
  );
}
