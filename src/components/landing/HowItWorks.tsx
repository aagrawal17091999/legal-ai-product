const steps = [
  {
    number: "01",
    title: "Ask a question or bring a document",
    description:
      "Describe a legal question in plain English — maintenance under Section 125 CrPC, res judicata in writ proceedings — or upload your own files: contracts and pleadings into a workspace, or a scan, photo, or PDF to translate or OCR. No boolean operators, no keyword syntax.",
  },
  {
    number: "02",
    title: "Legal Brain grounds itself in the source",
    description:
      "For research, it searches a curated database of real Supreme Court and High Court judgments. For your documents, it reads only what you uploaded — using vision AI to handle scans, faded ink, and handwriting. It works from the actual source, not from memory.",
  },
  {
    number: "03",
    title: "Get cited answers or court-ready files",
    description:
      "Answers stream in real time with inline citations you can click to open the exact passage. Download cited judgment PDFs, or export translated and OCR'd documents as formatted Word and PDF files — with anything the model is unsure about flagged for your review.",
  },
];

export default function HowItWorks() {
  return (
    <section id="how-it-works" className="bg-ivory-50 py-24 sm:py-32">
      <div className="max-w-[1200px] mx-auto px-6 sm:px-8">
        {/* Section header */}
        <div className="max-w-2xl">
          <span className="overline">How it works</span>
          <h2 className="mt-6 font-serif text-4xl sm:text-[44px] leading-[1.1] tracking-tight text-charcoal-900">
            From question — or document — to cited answer.
          </h2>
        </div>

        {/* Steps */}
        <div className="mt-20 grid md:grid-cols-3 gap-12 md:gap-10">
          {steps.map((step, idx) => (
            <div key={step.number} className="relative">
              {idx > 0 && (
                <div className="hidden md:block absolute left-0 -top-2 w-12 h-px bg-ivory-200" />
              )}
              <div className="font-serif text-[64px] leading-none text-gold-500">
                {step.number}
              </div>
              <h3 className="mt-5 text-xl font-semibold text-charcoal-900">
                {step.title}
              </h3>
              <p className="mt-3 text-[15px] text-charcoal-600 leading-relaxed">
                {step.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
