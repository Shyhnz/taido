/** Text that gives French away in the English interface (step 3, review focus 5). */
const DENYLIST: (string | RegExp)[] = [
  /[éèàçùêôîûïœ«»]/,
  " le ",
  " la ",
  " les ",
  " des ",
  "Tâche",
  "Réglages",
  "Sans projet",
  "Prochainement",
];

/** The first denylist entry `text` contains, or null. */
export function frenchIn(text: string): string | null {
  for (const entry of DENYLIST) {
    if (typeof entry === "string" ? text.includes(entry) : entry.test(text)) {
      return String(entry);
    }
  }
  return null;
}
