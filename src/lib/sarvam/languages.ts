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

/**
 * Writing system for each supported language.
 *
 * Used to tell whether a translation actually happened: `sarvam-translate:v1` is
 * an instruction-tuned LLM, and when it drops out of "translate" mode it returns
 * the input verbatim with HTTP 200. Absence and failure we already detect; a
 * confident echo we did not. Comparing how much SOURCE-script text survived into
 * the output catches it, and script is the cheapest reliable signal.
 *
 * Manipuri is written in both Bengali and Meetei Mayek; it is mapped to Bengali
 * because that is what Sarvam emits. Where a script is unknown the check is
 * skipped rather than guessed — a missed echo is recoverable, a false positive
 * would push every job onto the expensive fallback.
 */
export type Script =
  | "latin"
  | "devanagari"
  | "bengali"
  | "gujarati"
  | "gurmukhi"
  | "kannada"
  | "malayalam"
  | "odia"
  | "tamil"
  | "telugu"
  | "arabic"
  | "olchiki";

const SCRIPT_BY_CODE: Record<string, Script> = {
  "en-IN": "latin",
  "hi-IN": "devanagari",
  "mr-IN": "devanagari",
  "ne-IN": "devanagari",
  "sa-IN": "devanagari",
  "doi-IN": "devanagari",
  "brx-IN": "devanagari",
  "kok-IN": "devanagari",
  "mai-IN": "devanagari",
  "bn-IN": "bengali",
  "as-IN": "bengali",
  "mni-IN": "bengali",
  "gu-IN": "gujarati",
  "pa-IN": "gurmukhi",
  "kn-IN": "kannada",
  "ml-IN": "malayalam",
  "od-IN": "odia",
  "ta-IN": "tamil",
  "te-IN": "telugu",
  "ur-IN": "arabic",
  "ks-IN": "arabic",
  "sd-IN": "arabic",
  "sat-IN": "olchiki",
};

/** Unicode range for each script, as a character class body. */
const RANGE: Record<Script, string> = {
  latin: "A-Za-z",
  devanagari: "\\u0900-\\u097F",
  bengali: "\\u0980-\\u09FF",
  gujarati: "\\u0A80-\\u0AFF",
  gurmukhi: "\\u0A00-\\u0A7F",
  kannada: "\\u0C80-\\u0CFF",
  malayalam: "\\u0D00-\\u0D7F",
  odia: "\\u0B00-\\u0B7F",
  tamil: "\\u0B80-\\u0BFF",
  telugu: "\\u0C00-\\u0C7F",
  arabic: "\\u0600-\\u06FF\\u0750-\\u077F",
  olchiki: "\\u1C50-\\u1C7F",
};

/** The script a language is written in, or null when we don't know. */
export function scriptOf(code: string): Script | null {
  return SCRIPT_BY_CODE[(code || "").trim()] ?? null;
}

/** How many characters of `script` appear in `text`. */
export function countScript(text: string, script: Script): number {
  return (text.match(new RegExp(`[${RANGE[script]}]`, "g")) ?? []).length;
}

/** Every script range except `target`, as a character-class body. */
function foreignClass(target: Script): string {
  return (Object.keys(RANGE) as Script[])
    .filter((s) => s !== target)
    .map((s) => RANGE[s])
    .join("");
}

/** Punctuation and spacing that may sit inside a gloss without ending it. */
const GLOSS_FILLER = "\\s\\u0964\\u0965.,;:'\"\\-–—/&%°";

/**
 * Remove bilingual GLOSSES — source-script text kept deliberately beside its
 * target-language equivalent — so a script census measures translated content
 * rather than preserved labels.
 *
 * This exists because of a 50-page Mathura police case diary. It is a
 * pre-printed government form whose field labels are bilingual on the page, so a
 * faithful English translation legitimately reads:
 *
 *   Case Diary Details / प्रकरण दैनिकी का विवरण
 *   a) Date of Preparing the Case Diary (प्रकरण दैनिकी तैयार करने की दिनांक)
 *
 * Every character in those glosses counted as evidence of an untranslated page.
 * Measured on that document's finished, human-verified output, the region the
 * escalation check scores worst sat at 15.6% Devanagari against a 15% threshold —
 * correct work, one rounding error away from being thrown out and redone on the
 * expensive model. With glosses removed the same region scores 0.3%, while a
 * genuinely untranslated page from the bylaws incident is untouched at 91.1%.
 *
 * Two patterns, both requiring the gloss to be INTRODUCED by target-script text:
 * a parenthetical `English (देवनागरी)` and a slash pair `English / देवनागरी`.
 * That precondition is what keeps this from eating a real passthrough — an
 * untranslated page is source script with nothing introducing it, so nothing
 * matches and its census is unchanged. Removal can therefore only ever LOWER a
 * foreign-script score, never raise one, so it cannot manufacture a new failure.
 */
export function stripGlosses(text: string, target: Script): string {
  const t = `[${RANGE[target]}]`;
  const f = `[${foreignClass(target)}]`;
  return (
    text
      // "English Label (देवनागरी)" → "English Label "
      .replace(
        new RegExp(`(${t}[^()\\n]{0,80}?)\\(([^()\\n]*${f}[^()\\n]*)\\)`, "g"),
        "$1"
      )
      // "English Title / देवनागरी title" → "English Title / "
      .replace(
        new RegExp(`(${t}[^\\n]{0,80}?/\\s*)((?:${f}|[${GLOSS_FILLER}])+)`, "g"),
        "$1"
      )
  );
}

/** Letters that must be present before a script census means anything. */
const MIN_LETTERS_TO_JUDGE = 50;

/** Share of counted letters one script must hold to be called dominant. */
const DOMINANT_SHARE = 0.6;

/**
 * The script `text` is predominantly written in, or null when there isn't enough
 * evidence — too few letters, or a genuinely mixed document. Characters in
 * scripts absent from RANGE simply aren't counted, so an unsupported writing
 * system yields null rather than a wrong answer.
 */
export function dominantScript(text: string): Script | null {
  let total = 0;
  let best: Script | null = null;
  let bestCount = 0;
  for (const script of Object.keys(RANGE) as Script[]) {
    const n = countScript(text, script);
    total += n;
    if (n > bestCount) {
      bestCount = n;
      best = script;
    }
  }
  if (total < MIN_LETTERS_TO_JUDGE || !best) return null;
  return bestCount / total >= DOMINANT_SHARE ? best : null;
}

/**
 * Whether `text` is plausibly written in `code`'s language.
 *
 * This exists because Sarvam /text-lid reported `en-IN` for a page that was
 * 96.6% Devanagari, and the pipeline believed it — with the target also English,
 * the "already in the target language" short-circuit fired and the document was
 * never translated at all. Script is a coarse signal (it cannot tell Hindi from
 * Marathi) but it is decisive for exactly the failure that occurred: a detection
 * naming a language written in a completely different script from the text.
 *
 * Returns true whenever there is genuine doubt, so the cheap Sarvam path is only
 * abandoned on positive evidence that the detection is wrong.
 */
export function scriptMatchesLanguage(text: string, code: string): boolean {
  const claimed = scriptOf(code);
  const actual = dominantScript(text);
  if (!claimed || !actual) return true;
  return claimed === actual;
}

/**
 * Share of `text`'s letters that are NOT in `code`'s script, or null when there
 * isn't enough text to judge.
 *
 * This is the output-side counterpart to {@link scriptMatchesLanguage}: it asks
 * "does this finished translation still look like the source?" rather than "what
 * language is this input?". A real translation scores near zero — proper nouns
 * are transliterated, not copied — so anything substantial means the model
 * structured the text without translating it.
 */
export function foreignScriptShare(text: string, code: string): number | null {
  const target = scriptOf(code);
  if (!target) return null;
  let total = 0;
  let native = 0;
  for (const script of Object.keys(RANGE) as Script[]) {
    const n = countScript(text, script);
    total += n;
    if (script === target) native = n;
  }
  if (total < MIN_LETTERS_TO_JUDGE) return null;
  return (total - native) / total;
}
