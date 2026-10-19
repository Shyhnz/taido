// Existing tests assert French texts. This module is the first import of `setup.ts`, so French
// is stored before any module reads the language. Tests of English set the key themselves and
// re-import what they need (`vi.resetModules()`).
if (typeof window !== "undefined") {
  window.localStorage.setItem("taido.language", "fr");
}
