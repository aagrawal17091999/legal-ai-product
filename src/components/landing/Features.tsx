const features = [
  {
    title: "Every answer cites the source",
    description:
      "Responses include inline citations — [^1], [^2], [^3] — each linked directly to the relevant passage in the source judgment. No vague references. No invented case names. Trace every statement back to the original text.",
  },
  {
    title: "Pre-filters that match how you think",
    description:
      "Filter by court, bench strength, judge name, acts and sections cited, case category, petitioner, respondent, case number, or year range. Research the way you already organise your arguments — by jurisdiction, authority, and relevance.",
  },
  {
    title: "Direct PDF access to full judgments",
    description:
      "Every cited judgment is available as a downloadable PDF. No redirects, no paywalls within the product, no broken links. The judgment you need, in the format courts accept.",
  },
  {
    title: "Supreme Court and High Court coverage",
    description:
      "NyayaSearch indexes judgments from the Supreme Court of India and High Courts across all states. Coverage is continuously expanding, with new judgments added regularly.",
  },
  {
    title: "Streaming answers in real time",
    description:
      "Responses begin generating immediately and stream paragraph by paragraph. No waiting for a complete response. Start reading, evaluating, and planning your next query while the answer is still forming.",
  },
  {
    title: "Your research history, preserved",
    description:
      "Every query and response is saved to your account. Return to previous research sessions, review earlier answers, and build on work you have already done — across days, weeks, or months.",
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
            Built for how Indian lawyers actually research.
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
