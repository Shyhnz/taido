/**
 * `[[` in a page opens the list of the project's pages, then its tasks
 *: typing narrows it, ↑ ↓ choose, Entrée or a tap inserts
 * the link, Échap closes it. Built on Tiptap's `Suggestion` utility.
 */

import { type Editor, Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, {
  type SuggestionKeyDownProps,
  type SuggestionProps,
} from "@tiptap/suggestion";
import { CircleCheck, FileText } from "lucide-react";
import { fr } from "../../../i18n/fr";
import { IS_MOBILE } from "../../../lib/target";
import { linkLabel, type WikiLinkKind } from "./wikiLink";

export interface LinkItem {
  kind: WikiLinkKind;
  id: string;
  title: string;
}

/** What `[[` can link: read when the list opens and at each key. */
export type LinkSource = () => { pages: LinkItem[]; tasks: LinkItem[] };

/** Most items of each kind the list shows. */
const MAX_EACH = 6;

/** Lower case, without accents. */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** Pages then tasks whose title holds every word of `query`. */
export function filterLinkItems(
  source: ReturnType<LinkSource>,
  query: string,
): LinkItem[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const keep = (items: LinkItem[]) =>
    items
      .filter((i) => {
        const title = fold(i.title);
        return words.every((w) => title.includes(w));
      })
      .slice(0, MAX_EACH);
  return [...keep(source.pages), ...keep(source.tasks)];
}

/** Opens the list from a button: types `[[` where the caret is. */
export function startWikiLink(editor: Editor): void {
  const { $from } = editor.state.selection;
  const before = $from.parent.textBetween(
    Math.max(0, $from.parentOffset - 1),
    $from.parentOffset,
  );
  // `[[` right after a letter would still open the list; a space reads better.
  const text = before.length > 0 && !/\s/.test(before) ? " [[" : "[[";
  editor.chain().focus().insertContent(text).run();
}

interface ListProps {
  items: LinkItem[];
  index: number;
  choose: (item: LinkItem) => void;
}

function SuggestList({ items, index, choose }: ListProps) {
  const firstTask = items.findIndex((i) => i.kind === "task");
  return (
    <div
      role="listbox"
      aria-label={fr.notes.editor.linkSuggest}
      className="max-h-[min(320px,50vh)] w-[min(320px,calc(100vw-32px))] overflow-y-auto rounded-lg border border-border bg-bg p-1 shadow-pop"
    >
      {items.length === 0 && (
        <p className="px-2.5 py-2 text-[13.5px] text-text-3">
          {fr.notes.editor.linkNone}
        </p>
      )}
      {items.map((item, i) => (
        <div key={`${item.kind}:${item.id}`}>
          {(i === 0 || i === firstTask) && (
            <p
              aria-hidden
              className="px-2.5 pt-1.5 pb-0.5 text-[11px] font-semibold tracking-wide text-text-3 uppercase"
            >
              {item.kind === "page"
                ? fr.notes.editor.linkPages
                : fr.notes.editor.linkTasks}
            </p>
          )}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: the page's text drives the keyboard (↑ ↓ Entrée) */}
          <div
            role="option"
            aria-selected={i === index}
            tabIndex={-1}
            // The editor keeps the focus; a tap chooses.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(item)}
            className={`flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 ${
              IS_MOBILE ? "min-h-11 text-[15px]" : "min-h-9 text-[14px]"
            } ${i === index ? "bg-selected text-text" : "text-text"}`}
          >
            {item.kind === "page" ? (
              <FileText
                size={15}
                aria-hidden
                className="shrink-0 text-text-3"
              />
            ) : (
              <CircleCheck
                size={15}
                aria-hidden
                className="shrink-0 text-text-3"
              />
            )}
            <span className="min-w-0 truncate">{item.title}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export const linkSuggestKey = new PluginKey("wikiLinkSuggest");

export interface LinkSuggestOptions {
  source: LinkSource;
}

export const LinkSuggest = Extension.create<LinkSuggestOptions>({
  name: "linkSuggest",

  addOptions() {
    return { source: () => ({ pages: [], tasks: [] }) };
  },

  addProseMirrorPlugins() {
    const source = this.options.source;
    return [
      Suggestion<LinkItem, LinkItem>({
        editor: this.editor,
        pluginKey: linkSuggestKey,
        char: "[[",
        allowSpaces: true,
        allowedPrefixes: null,
        // `![[` is an image (plan task 8), not a link.
        allow: ({ state, range }) =>
          state.doc.textBetween(Math.max(0, range.from - 1), range.from) !==
          "!",
        items: ({ query }) => filterLinkItems(source(), query),
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              {
                type: "wikiLink",
                attrs: {
                  kind: props.kind,
                  id: props.id,
                  label: linkLabel(props.title),
                },
              },
              { type: "text", text: " " },
            ])
            .run();
        },
        render: () => {
          let renderer: ReactRenderer<unknown, ListProps> | null = null;
          let unmount: (() => void) | null = null;
          let index = 0;
          let current: SuggestionProps<LinkItem, LinkItem> | null = null;
          const listProps = (): ListProps => ({
            items: current?.items ?? [],
            index,
            choose: (item) => current?.command(item),
          });
          return {
            onStart: (props) => {
              current = props;
              index = 0;
              renderer = new ReactRenderer(SuggestList, {
                props: listProps(),
                editor: props.editor,
              });
              unmount = props.mount(renderer.element as HTMLElement);
              (renderer.element as HTMLElement).style.zIndex = "60";
            },
            onUpdate: (props) => {
              current = props;
              index = Math.min(index, Math.max(0, props.items.length - 1));
              renderer?.updateProps(listProps());
            },
            onKeyDown: ({ event }: SuggestionKeyDownProps) => {
              const items = current?.items ?? [];
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                if (items.length === 0) return true;
                const step = event.key === "ArrowDown" ? 1 : -1;
                index = (index + step + items.length) % items.length;
                renderer?.updateProps(listProps());
                return true;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                const item = items[index];
                if (!item) return false;
                current?.command(item);
                return true;
              }
              return false;
            },
            onExit: () => {
              unmount?.();
              renderer?.destroy();
              renderer = null;
              unmount = null;
              current = null;
            },
          };
        },
      }),
    ];
  },
});
