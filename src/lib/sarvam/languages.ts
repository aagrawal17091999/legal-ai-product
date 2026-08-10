/**
 * Translation target languages.
 *
 * The 22 languages in the Eighth Schedule of the Constitution plus English —
 * the set Sarvam's stack covers. The translation itself is done by Claude (which
 * is not restricted to these), so this list is a PRODUCT choice: it keeps the
 * feature to the languages Indian legal filings actually need and to the ones
 * the OCR reading step is tuned for. Widening it is a one-line change here.
 *
 * The BCP-47 codes are Sarvam's (`hi-IN`, `ta-IN`, …) and are kept so a future
 * caller can pass a source/target language hint to a Sarvam endpoint; the
 * digitise call deliberately sends none (the source language is auto-detected).
 */

export interface SupportedLanguage {
  /** Display name — also what's stored in translation_jobs.target_language. */
  name: string;
  /** Sarvam BCP-47 code. */
  code: string;
}

export const SUPPORTED_LANGUAGES: SupportedLanguage[] = [
  { name: "English", code: "en-IN" },
  { name: "Hindi", code: "hi-IN" },
  { name: "Assamese", code: "as-IN" },
  { name: "Bengali", code: "bn-IN" },
  { name: "Bodo", code: "brx-IN" },
  { name: "Dogri", code: "doi-IN" },
  { name: "Gujarati", code: "gu-IN" },
  { name: "Kannada", code: "kn-IN" },
  { name: "Kashmiri", code: "ks-IN" },
  { name: "Konkani", code: "kok-IN" },
  { name: "Maithili", code: "mai-IN" },
  { name: "Malayalam", code: "ml-IN" },
  { name: "Manipuri", code: "mni-IN" },
  { name: "Marathi", code: "mr-IN" },
  { name: "Nepali", code: "ne-IN" },
  { name: "Odia", code: "od-IN" },
  { name: "Punjabi", code: "pa-IN" },
  { name: "Sanskrit", code: "sa-IN" },
  { name: "Santali", code: "sat-IN" },
  { name: "Sindhi", code: "sd-IN" },
  { name: "Tamil", code: "ta-IN" },
  { name: "Telugu", code: "te-IN" },
  { name: "Urdu", code: "ur-IN" },
];

/** Display names for the target-language picker. */
export const LANGUAGE_NAMES: string[] = SUPPORTED_LANGUAGES.map((l) => l.name);

/** Case-insensitive lookup, so an older job row or a hand-typed value still resolves. */
export function findLanguage(name: string): SupportedLanguage | undefined {
  const needle = (name || "").trim().toLowerCase();
  return SUPPORTED_LANGUAGES.find((l) => l.name.toLowerCase() === needle);
}

export function isSupportedLanguage(name: string): boolean {
  return findLanguage(name) !== undefined;
}

/** Sarvam BCP-47 code for a display name, or null if unsupported. */
export function languageCode(name: string): string | null {
  return findLanguage(name)?.code ?? null;
}

/**
 * Display name for a Sarvam code — used to record the DETECTED source language
 * in a form the UI already shows. Falls back to the raw code so an unexpected
 * value still surfaces something meaningful rather than "Unknown".
 */
export function languageName(code: string): string {
  const needle = (code || "").trim().toLowerCase();
  return SUPPORTED_LANGUAGES.find((l) => l.code.toLowerCase() === needle)?.name || code;
}
