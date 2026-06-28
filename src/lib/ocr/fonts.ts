/**
 * Fonts for the OCR → PDF renderer.
 *
 * Headless Chromium (@sparticuz/chromium) ships with NO Indic fonts, so Hindi,
 * Gujarati, Tamil, etc. would render as tofu boxes. We register the needed Noto
 * fonts at runtime via `chromium.font(url)`, but only the ones the document
 * actually uses — scanning every output for the relevant Unicode block and
 * registering just those keeps cold starts lean.
 *
 * URLs point at the official Noto TTFs on jsdelivr (validated). They can be
 * overridden with the OCR_FONT_BASE env var if the CDN path ever changes.
 */

const FONT_BASE =
  process.env.OCR_FONT_BASE?.trim() ||
  "https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts";

const ttf = (family: string) => `${FONT_BASE}/${family}/unhinted/ttf/${family}-Regular.ttf`;

export interface FontSpec {
  /** CSS font-family name (must match what Chromium reads from the TTF). */
  cssName: string;
  /** Download URL passed to chromium.font(). */
  url: string;
  /** True if this script appears in the given text. */
  matches: (text: string) => boolean;
}

const has = (re: RegExp) => (text: string) => re.test(text);

// Latin/base serif is always registered (cause-titles, case numbers, English).
export const BASE_FONT: FontSpec = {
  cssName: "Noto Serif",
  url: ttf("NotoSerif"),
  matches: () => true,
};

// Script-specific fonts, registered on demand. Order here is the CSS fallback
// order; Chromium picks the first family that covers each character.
const SCRIPT_FONTS: FontSpec[] = [
  { cssName: "Noto Serif Devanagari", url: ttf("NotoSerifDevanagari"), matches: has(/[ऀ-ॿ]/) }, // Hindi/Marathi/Sanskrit
  { cssName: "Noto Sans Gujarati", url: ttf("NotoSansGujarati"), matches: has(/[઀-૿]/) },
  { cssName: "Noto Sans Bengali", url: ttf("NotoSansBengali"), matches: has(/[ঀ-৿]/) },
  { cssName: "Noto Sans Gurmukhi", url: ttf("NotoSansGurmukhi"), matches: has(/[਀-੿]/) }, // Punjabi
  { cssName: "Noto Sans Tamil", url: ttf("NotoSansTamil"), matches: has(/[஀-௿]/) },
  { cssName: "Noto Sans Telugu", url: ttf("NotoSansTelugu"), matches: has(/[ఀ-౿]/) },
  { cssName: "Noto Sans Kannada", url: ttf("NotoSansKannada"), matches: has(/[ಀ-೿]/) },
  { cssName: "Noto Sans Malayalam", url: ttf("NotoSansMalayalam"), matches: has(/[ഀ-ൿ]/) },
  { cssName: "Noto Sans Oriya", url: ttf("NotoSansOriya"), matches: has(/[଀-୿]/) },
  { cssName: "Noto Nastaliq Urdu", url: ttf("NotoNastaliqUrdu"), matches: has(/[؀-ۿݐ-ݿ]/) },
];

/** Pick the fonts needed for `text`: the base serif plus any script fonts whose
 *  Unicode block appears. Returned in CSS fallback order. */
export function fontsForText(text: string): FontSpec[] {
  return [BASE_FONT, ...SCRIPT_FONTS.filter((f) => f.matches(text))];
}

/** Build the CSS `font-family` value from a list of font specs. */
export function fontFamilyStack(fonts: FontSpec[]): string {
  return [...fonts.map((f) => `'${f.cssName}'`), "serif"].join(", ");
}
