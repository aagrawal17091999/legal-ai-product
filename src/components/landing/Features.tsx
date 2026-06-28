const features = [
  {
    title: "Case-law research, grounded in judgments",
    description:
      "Ask a legal question in plain English and get a synthesised answer drawn from real Supreme Court and High Court judgments. Inline citations — [^1], [^2], [^3] — link to the exact passage in the source judgment. No invented case names; trace every statement back to the original text.",
  },
  {
    title: "Document Workspaces — chat with your own files",
    description:
      "Upload your contracts, pleadings, and case files into a private workspace and ask questions answered only from those documents. Every answer cites the source document and page, and shows the exact snippet. If the answer isn't in your files, the assistant says so instead of guessing.",
  },
  {
    title: "Translate legal documents, structure intact",
    description:
      "Translate a PDF, DOCX, scan, or photo into any language with a single vision-native pass that preserves headings, numbered clauses, tables, party labels, and signatures. Download a formatted, court-ready Word file — faded ink and handwriting are read, and anything uncertain is flagged for human review.",
  },
  {
    title: "OCR scanned & handwritten documents",
    description:
      "Turn scans, photos, and handwritten notes into clean, structured text in the original language — no translation. Stamps, seals, and faded type are read by vision AI, layout is preserved, and the result downloads as a tidy PDF or editable Word file with uncertain passages flagged.",
  },
  {
    title: "Pre-filters that match how you think",
    description:
      "Filter case-law research by court, bench strength, judge name, acts and sections cited, case category, petitioner, respondent, case number, or year range — and download every cited judgment as a PDF, in the format courts accept.",
  },
  {
    title: "Streaming answers and saved history",
    description:
      "Responses stream paragraph by paragraph so you can start reading immediately. Every research session, workspace, and document job is saved to your account — return to earlier work and build on it across days, weeks, or months.",
  },
];

export default function Features() {
  return (
    <section id="features" className="bg-navy-950 text-ivory-50 py-24 sm:py-32">
      <div className="max-w-[1200px] mx-auto px-6 sm:px-8">
        {/* Section header */}
        <div className="max-w-2xl">
          <span className="overline">Features</span>
          <h2 className="mt-6 font-serif text-4xl sm:text-[44px] leading-[1.1] tracking-tight text-ivory-50">
            One workspace for research, your documents, translation, and OCR.
          </h2>
        </div>

        {/* Feature grid */}
        <div className="mt-16 grid sm:grid-cols-2 lg:grid-cols-3 gap-px bg-white/10 border border-white/10">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="bg-navy-950 p-8 hover:bg-navy-900 transition-colors"
            >
              <h3 className="font-serif text-2xl text-ivory-50 leading-snug">
                {feature.title}
              </h3>
              <p className="mt-4 text-[15px] text-charcoal-400 leading-relaxed">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
