/**
 * « Pièces jointes » in the task panel. Files
 * are copied into the task's folder (`~/Taido/Pièces jointes/<projet>/<tâche>`), readable by
 * Claude. Add them by dropping files on the zone (or on the task's row, see `fileDrop.ts`),
 * pasting a screenshot (⌘V) or « parcourir ». A grid: preview for images, an icon otherwise.
 * A tile says where its file stands with the account (`Attachment.remote`, computed
 * by the core): only here, being sent, to download, being downloaded, or refused.
 *
 * « Télécharger » (2026-10-10, by design: « propose de télécharger le fichier », like Todoist and
 * Slack) is the tile's first action and its double-click, on every surface, for every file,
 * wherever it was added. On the Mac the core copies the file into the Downloads folder under
 * a free name, fetching it from the server first when it is not here yet, then a toast offers
 * « Afficher dans le Finder ».
 *
 * The web app (site and phone, `IS_MOBILE`) has no disk nor Finder: files come from the
 * browser (picker, which offers the camera and photos on a phone, paste, drop) through
 * `webFiles()` (src/mobile/files.ts); « Télécharger » saves the file, images included, never
 * opening it in a tab (src/lib/web-files.ts).
 * Since 2026-10-12 a raster image's tile shows its thumbnail there too (`WebPreview`, in an
 * `<img>` only), from the device or downloaded when it weighs 10 MB at most.
 */

import { useQuery } from "@tanstack/react-query";
import { File, FileImage, FileText, Mail, Paperclip, X } from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Attachment, TaskDetail } from "../../bindings";
import { confirmDialog } from "../../components/Dialog";
import {
  type MenuItem,
  openContextMenu,
  openMenuAt,
} from "../../components/Menu";
import { showError, showToast } from "../../components/Toast";
import { t } from "../../i18n";
import { useDefaultAgent } from "../../lib/agent";
import { formatSessionStart } from "../../lib/dates";
import { commands, errorKind, errorMessage, webFiles } from "../../lib/ipc";
import { readableError, run } from "../../lib/run";
import { IS_MOBILE } from "../../lib/target";
import {
  hasPreview,
  saveBlob,
  type WebAttachmentFiles,
  WebFileError,
} from "../../lib/web-files";
import { Fold } from "../task-panel/PanelFold";

function Icon({ attachment }: { attachment: Attachment }) {
  const m = attachment.mimeType;
  const C = attachment.isImage
    ? FileImage
    : m === "message/rfc822"
      ? Mail
      : m.startsWith("text/") || m === "application/pdf"
        ? FileText
        : File;
  return <C size={22} aria-hidden className="text-text-3" />;
}

function Preview({ attachment }: { attachment: Attachment }) {
  const { data } = useQuery({
    queryKey: ["attachmentPreview", attachment.id],
    queryFn: () => commands.attachmentPreview(attachment.id),
    enabled: attachment.isImage && attachment.exists,
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (data) {
    return (
      <img
        src={data}
        alt=""
        className="h-full w-full rounded-md object-cover"
      />
    );
  }
  return <Icon attachment={attachment} />;
}

/**
 * A raster image's thumbnail in the web app: its bytes from the device or the account, shown
 * through a `blob:` URL in an `<img>` (never navigated to), revoked when the tile goes.
 */
function WebPreview({
  attachment,
  files,
}: {
  attachment: Attachment;
  files: WebAttachmentFiles;
}) {
  const { data } = useQuery({
    queryKey: ["webAttachmentPreview", attachment.id],
    queryFn: () => files.preview(attachment.id),
    enabled: hasPreview(attachment.mimeType, attachment.size),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!data) return;
    const objectUrl = URL.createObjectURL(data);
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [data]);
  if (url) {
    return (
      <img src={url} alt="" className="h-full w-full rounded-md object-cover" />
    );
  }
  return <Icon attachment={attachment} />;
}

/**
 * Removes the attachment from every device (and, on the Mac, the task's copy of the file),
 * after a confirmation.
 */
async function remove(a: Attachment) {
  const ok = await confirmDialog({
    title: t.attachments.deleteTitle(a.fileName),
    message: IS_MOBILE
      ? t.attachments.web.deleteMessage
      : t.attachments.deleteMessage,
    confirmLabel: t.attachments.delete,
  });
  if (ok) void run(commands.deleteAttachment(a.id));
}

/**
 * The attachments being downloaded from this panel: their tile says « Téléchargement… » and a
 * second « Télécharger » meanwhile does nothing. `start` runs `work` for `id` once at a time.
 */
function useDownloading(): [
  ReadonlySet<string>,
  (id: string, work: () => Promise<void>) => void,
] {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  const running = useRef(new Set<string>());
  const start = (id: string, work: () => Promise<void>) => {
    if (running.current.has(id)) return;
    running.current.add(id);
    setIds(new Set(running.current));
    void work().finally(() => {
      running.current.delete(id);
      setIds(new Set(running.current));
    });
  };
  return [ids, start];
}

/**
 * « Télécharger » on the Mac: the core puts a copy in the Downloads folder (fetched from the
 * server first when the file is not here yet), then a toast offers to show it in the Finder.
 */
async function downloadOnMac(a: Attachment): Promise<void> {
  try {
    const copy = await commands.downloadAttachment(a.id);
    showToast({
      message: t.attachments.downloaded,
      action: {
        label: t.attachments.reveal,
        onAction: () => void run(commands.revealPath(copy)),
      },
    });
  } catch (error) {
    console.error(errorMessage(error), error);
    showError(downloadErrorText(error));
  }
}

/** French text of a failed « Télécharger » on the Mac. */
function downloadErrorText(error: unknown): string {
  const kind = errorKind(error);
  if (kind === "sync_auth") return t.sync.error.unauthorized;
  if (kind === "sync_offline" || kind === "sync_server") {
    return t.attachments.downloadError[kind];
  }
  return readableError(error);
}

/** Not on this Mac and nothing can bring it (no account): « Télécharger » is off. */
const unreachable = (a: Attachment) => !a.exists && a.remote === "none";

function macItems(
  a: Attachment,
  busy: boolean,
  download: () => void,
): MenuItem[] {
  return [
    {
      label: t.attachments.download,
      disabled: busy || unreachable(a),
      onSelect: download,
    },
    {
      label: t.attachments.reveal,
      disabled: !a.exists,
      onSelect: () => void run(commands.revealAttachment(a.id)),
    },
    { separator: true },
    {
      label: t.attachments.delete,
      danger: true,
      onSelect: () => void remove(a),
    },
  ];
}

/**
 * The tile's line about the account, or nothing when the file is everywhere it should be;
 * « Téléchargement… » while « Télécharger » runs (`busy`).
 */
function RemoteLine({
  attachment,
  busy,
}: {
  attachment: Attachment;
  busy: boolean;
}) {
  const remote = busy ? "downloading" : attachment.remote;
  if (remote === "none") return null;
  const refused = remote === "too_large" || remote === "quota_full";
  const label =
    IS_MOBILE && remote === "local_only"
      ? t.attachments.web.localOnly
      : t.attachments.remote[remote];
  return (
    <span
      className={`truncate px-0.5 text-[11px] ${refused ? "text-due-overdue" : "text-text-3"}`}
    >
      {label}
    </span>
  );
}

function Tile({
  attachment,
  items,
  busy,
  onDownload,
  preview,
}: {
  attachment: Attachment;
  items: MenuItem[];
  /** « Télécharger » is running for it. */
  busy: boolean;
  /** Double-click: « Télécharger ». */
  onDownload: () => void;
  preview: ReactNode;
}) {
  const label = t.attachments.menu(attachment.fileName);
  // A file on its way here is not « introuvable »: its size shows until it arrives.
  const coming =
    attachment.remote === "to_download" || attachment.remote === "downloading";
  return (
    <li className="group/tile relative min-w-0">
      <button
        type="button"
        title={attachment.path}
        aria-busy={busy}
        onDoubleClick={onDownload}
        onClick={(e) => openMenuAt(e.currentTarget, items, label)}
        onContextMenu={(e) => openContextMenu(e, items, label)}
        aria-label={label}
        className="flex w-full flex-col gap-1.5 rounded-lg border border-border p-1.5 text-left hover:bg-hover"
      >
        <span className="flex h-16 w-full items-center justify-center rounded-md bg-hover/60">
          {preview}
        </span>
        <span className="truncate px-0.5 text-[12px] text-text">
          {attachment.fileName}
        </span>
        <span className="truncate px-0.5 text-[11px] text-text-3">
          {attachment.exists
            ? `${t.attachments.size(attachment.size)} · ${formatSessionStart(attachment.addedAt)}`
            : coming
              ? t.attachments.size(attachment.size)
              : t.attachments.missing}
        </span>
        <RemoteLine attachment={attachment} busy={busy} />
      </button>
      <button
        type="button"
        aria-label={t.attachments.removeOne(attachment.fileName)}
        title={t.attachments.removeOne(attachment.fileName)}
        onClick={() => void remove(attachment)}
        className="absolute top-2.5 right-2.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-elevated text-text-3 opacity-0 shadow-sm hover:bg-hover hover:text-text group-hover/tile:opacity-100 focus-visible:opacity-100"
      >
        <X size={12} aria-hidden />
      </button>
    </li>
  );
}

/** Base64 of a pasted file. */
export async function toBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** A screenshot's generic name (`image.png`) becomes « capture-<date>.png ». */
export function pastedName(file: File): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return file.name && file.name !== "image.png"
    ? file.name
    : t.attachments.pasted(stamp);
}

/** A screenshot pasted in the panel becomes an attachment of the task. */
export async function pasteFiles(taskId: string, e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.files ?? []);
  if (files.length === 0) return;
  e.preventDefault();
  for (const file of files) {
    await run(
      commands.addAttachmentData({
        taskId,
        name: pastedName(file),
        base64: await toBase64(file),
      }),
    );
  }
}

/** Title, count and hint, the tiles, then the zone that takes new files. */
function Layout({
  task,
  hint,
  tiles,
  zone,
  onPaste,
}: {
  task: TaskDetail;
  hint: string | null;
  tiles: ReactNode;
  zone: ReactNode;
  onPaste: (e: ClipboardEvent) => void;
}) {
  return (
    <Fold
      id="attachments"
      title={t.attachments.title}
      summary={
        task.attachments.length > 0 && t.folds.files(task.attachments.length)
      }
      attachTask={task.id}
      onPaste={onPaste}
    >
      {hint && <p className="mb-1.5 text-[12px] text-text-3">{hint}</p>}
      {task.attachments.length > 0 && (
        <ul className="mb-2 grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2">
          {tiles}
        </ul>
      )}
      {zone}
    </Fold>
  );
}

const ZONE =
  "flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-[12.5px] text-text-3 focus-visible:border-accent focus-visible:outline-none";

export function AttachmentsSection({ task }: { task: TaskDetail }) {
  const files = IS_MOBILE ? webFiles() : null;
  if (files) return <WebAttachmentsSection task={task} files={files} />;
  return <MacAttachmentsSection task={task} />;
}

function MacAttachmentsSection({ task }: { task: TaskDetail }) {
  const agent = useDefaultAgent();
  const [downloading, start] = useDownloading();
  const browse = async () => {
    const paths = await run(commands.pickFiles(t.attachments.pickTitle));
    if (paths && paths.length > 0) {
      await run(commands.addAttachments({ taskId: task.id, paths }));
    }
  };
  return (
    <Layout
      task={task}
      hint={t.attachments.hint(agent)}
      onPaste={(e) => void pasteFiles(task.id, e)}
      tiles={task.attachments.map((a) => {
        const download = () => {
          if (!unreachable(a)) start(a.id, () => downloadOnMac(a));
        };
        const busy = downloading.has(a.id);
        return (
          <Tile
            key={a.id}
            attachment={a}
            items={macItems(a, busy, download)}
            busy={busy}
            onDownload={download}
            preview={<Preview attachment={a} />}
          />
        );
      })}
      zone={
        <div
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the zone takes the focus so ⌘V pastes into it
          tabIndex={0}
          data-drop-zone
          className={ZONE}
        >
          <Paperclip size={14} aria-hidden />
          <span>
            {t.attachments.drop}{" "}
            <button
              type="button"
              onClick={() => void browse()}
              className="text-text-2 underline underline-offset-2 hover:text-text"
            >
              {t.attachments.browse}
            </button>
          </span>
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// The web app (site and phone)
// ---------------------------------------------------------------------------

/** French text of a failed file operation on the web. */
function webErrorText(error: unknown): string {
  if (error instanceof WebFileError) return t.attachments.web.error[error.kind];
  return readableError(error);
}

/** Adds files from the browser; says why it failed. */
async function addOnWeb(
  files: WebAttachmentFiles,
  taskId: string,
  list: File[],
): Promise<void> {
  if (list.length === 0) return;
  try {
    await files.add(taskId, list);
  } catch (error) {
    console.error(errorMessage(error), error);
    showError(webErrorText(error));
  }
}

const hasFiles = (dt: DataTransfer | null): boolean =>
  Array.from(dt?.types ?? []).includes("Files");

function WebAttachmentsSection({
  task,
  files,
}: {
  task: TaskDetail;
  files: WebAttachmentFiles;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [downloading, start] = useDownloading();
  // Hashing and keeping can take seconds: « Ajout… », and nothing is added twice meanwhile.
  const [adding, setAdding] = useState(false);
  const busy = useRef(false);

  const add = async (list: File[]) => {
    if (list.length === 0 || busy.current) return;
    busy.current = true;
    setAdding(true);
    try {
      await addOnWeb(files, task.id, list);
    } finally {
      busy.current = false;
      setAdding(false);
    }
  };

  // « Télécharger »: always saved, images too, never shown (review point 2).
  const download = (a: Attachment) =>
    start(a.id, async () => {
      try {
        const file = await files.open(a.id);
        saveBlob(file.blob, file.fileName);
      } catch (error) {
        console.error(errorMessage(error), error);
        showError(webErrorText(error));
      }
    });

  const items = (a: Attachment): MenuItem[] => [
    {
      label: t.attachments.download,
      disabled: downloading.has(a.id),
      onSelect: () => download(a),
    },
    { separator: true },
    {
      label: t.attachments.delete,
      danger: true,
      onSelect: () => void remove(a),
    },
  ];

  const onPaste = (e: ClipboardEvent) => {
    const list = Array.from(e.clipboardData?.files ?? []);
    if (list.length === 0) return;
    e.preventDefault();
    void add(
      list.map((f) => {
        const name = pastedName(f);
        // Only a screenshot's generic name is replaced (the file itself is kept as is).
        return name === f.name
          ? f
          : new globalThis.File([f], name, { type: f.type });
      }),
    );
  };

  const onDragOver = (e: DragEvent) => {
    if (hasFiles(e.dataTransfer)) e.preventDefault();
  };

  const onDrop = (e: DragEvent) => {
    const list = Array.from(e.dataTransfer?.files ?? []);
    if (list.length === 0) return;
    e.preventDefault();
    void add(list);
  };

  return (
    <Layout
      task={task}
      hint={null}
      onPaste={onPaste}
      tiles={task.attachments.map((a) => (
        <Tile
          key={a.id}
          attachment={a}
          items={items(a)}
          busy={downloading.has(a.id)}
          onDownload={() => download(a)}
          preview={<WebPreview attachment={a} files={files} />}
        />
      ))}
      zone={
        // biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the picker button inside is the accessible way
        <div
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the zone takes the focus so a paste lands in it
          tabIndex={0}
          data-drop-zone
          onDragOver={onDragOver}
          onDrop={onDrop}
          className={ZONE}
        >
          <Paperclip size={14} aria-hidden />
          <span>
            {t.attachments.web.drop}{" "}
            <button
              type="button"
              disabled={adding}
              onClick={() => input.current?.click()}
              className="text-text-2 underline underline-offset-2 hover:text-text disabled:opacity-50"
            >
              {t.attachments.browse}
            </button>
          </span>
          <span role="status" className="ml-auto shrink-0 text-text-2">
            {adding ? t.attachments.web.adding : ""}
          </span>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            tabIndex={-1}
            onChange={(e) => {
              const list = Array.from(e.currentTarget.files ?? []);
              e.currentTarget.value = "";
              void add(list);
            }}
          />
        </div>
      }
    />
  );
}
