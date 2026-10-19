/**
 * Page bodies the editor must give back unchanged when nothing is typed
 *.
 */

export const PAGE_ID = "0192f0a1-7c2b-7d3e-9f00-112233445566";
export const TASK_ID = "0192f0a1-7c2b-7d3e-9f00-aabbccddeeff";
export const FILE_ID = "0192f0a1-7c2b-7d3e-9f00-0123456789ab";

/** Every way a page image can be written (task 8): each comes back as written. */
export const IMAGE_FIXTURES: Record<string, string> = {
  imageWidth: `Capture :\n\n![[file:${FILE_ID}|50%]]`,
  imageFull: `![[file:${FILE_ID}|100%]]`,
  imageNoWidth: `![[file:${FILE_ID}]]`,
  imageInText: `Voir ![[file:${FILE_ID}|25%]] dans le texte.`,
  imageOddWidth: `![[file:${FILE_ID}|33%]]`,
  imageTooWide: `![[file:${FILE_ID}|250%]]`,
  imagePixels: `![[file:${FILE_ID}|300]]`,
  imageSpaced: `![[file:${FILE_ID}| 40 %]]`,
  twoImages: `![[file:${FILE_ID}|50%]]\n\n![[file:${PAGE_ID}|75%]]`,
  imageInList: `- une capture ![[file:${FILE_ID}|30%]]\n- deux`,
  imageInQuote: `> ![[file:${FILE_ID}|60%]]`,
};

export const MARKDOWN_FIXTURES: Record<string, string> = {
  headings: "# Serveur\n\n## Accès\n\n### Détails\n\nTexte simple.",
  bold: "Le mot **important** ici.",
  italic: "Le mot *penché* ici.",
  underline: "Le mot <u>souligné</u> ici.",
  strike: "Le mot ~~barré~~ ici.",
  highlight: "Le mot ==surligné== ici.",
  mixed: "**gras *et penché*** puis **<u>fort souligné</u>**.",
  bullets: "- un\n- deux\n  - sous-point\n- trois",
  ordered: "1. un\n2. deux\n3. trois",
  tasks: "- [ ] à faire\n- [x] fait\n  - [ ] sous-tâche",
  quote: "> Une citation\n> sur deux lignes",
  codeBlock: "```\nssh user@sync.example.com\n```",
  codeBlockLang: '```sh\necho "ok" && ls -la\n```',
  inlineCode: "Lancer `pnpm check` avant.",
  webLink: "Voir [la doc](https://tiptap.dev/docs) pour la suite.",
  pageLink: `Voir [[page:${PAGE_ID}|Style des mails]] avant d'écrire.`,
  taskLink: `Fait dans [[task:${TASK_ID}|Mails transactionnels]].`,
  linkWithoutLabel: `Voir [[page:${PAGE_ID}]].`,
  french:
    "« Bleu nuit » pour tous les mails : 12 € ; d’accord ? Oui !\n\nL’été — c’est « parfait ».",
  nonBreakingSpaces: "« Bleu nuit » : espaces insécables ; fines !",
  paragraphs: "Premier paragraphe.\n\nDeuxième paragraphe.",
  softBreak: "ligne une\nligne deux",
  hardBreak: "ligne une  \nligne deux",
  rule: "Avant\n\n---\n\nAprès",
  escaped: "Un \\* astérisque, un \\_ tiret bas et \\[\\[pas un lien\\]\\].",
  cPlusPlus: "C++ et C++ ne sont pas soulignés.",
  comparisons: "2 < 3 et 5 > 4, Tom & Jerry.",
  obsidianLink: "Une note Obsidian [[Idées]] reste telle quelle.",
  table: "Avant\n\n| Nom | Accès |\n| --- | --- |\n| VPS | ssh |\n\nAprès",
  htmlBlock:
    "Avant\n\n<details>\n<summary>Plus</summary>\nCaché\n</details>\n\nAprès",
  empty: "",
  ...IMAGE_FIXTURES,
};

/** Not written as the editor writes them: read the same, written its way after an edit. */
export const NORMALISED: [string, string][] = [
  ["* étoile\n* deux", "- étoile\n- deux"],
  ["_penché_ et __gras__", "*penché* et **gras**"],
  ["Titre\n=====", "# Titre"],
  // The editor's own escapes read back as text.
  ["Tom &amp; Jerry", "Tom & Jerry"],
  ["<u>**fort**</u>", "**<u>fort</u>**"],
  ["1) un\n2) deux", "1. un\n2. deux"],
];

/**
 * Markdown the editor does not edit, written by Claude or another tool: kept byte for byte
 * when the page is changed elsewhere (each follows a first paragraph the tests edit).
 */
export const PRESERVED: Record<string, string> = {
  image: "Logo : ![Le logo](https://example.com/logo.png) en haut.",
  imageNoAlt: "![](https://example.com/capture.png)",
  imageTitle: '![Capture](https://example.com/c.png "Écran d\'accueil")',
  inlineHtml: "Appuie sur <kbd>⌘</kbd> + <kbd>K</kbd>.",
  span: 'Texte <span style="color:red">rouge</span> ici.',
  lineBreakTag: "Ligne une<br>ligne deux",
  commentInline: "Avant <!-- note cachée --> après.",
  commentBlock: "<!-- TODO: vérifier -->",
  footnote:
    "Une affirmation[^1] et une autre[^note].\n\n[^1]: La source.\n\n[^note]: Une note.",
  referenceDefinition: "Voir [la doc][doc].\n\n[doc]: https://tiptap.dev",
  shortcutReference:
    "Voir [doc] et [la doc][].\n\n[doc]: https://tiptap.dev\n\n[la doc]: https://x.dev",
  entities: "Prix&nbsp;: 12&nbsp;€ &copy; Taido &#8212; fin.",
  imageEmbed: `Capture :\n\n![[file:${PAGE_ID}|50%]]`,
  // Not an attachment id: kept as written, not an image of the page.
  embedNotFile: "![[Une note Obsidian]] et ![[file:pas-un-id|50%]]",
  table: "| Nom | Accès |\n| --- | --- |\n| VPS | ssh |",
};
