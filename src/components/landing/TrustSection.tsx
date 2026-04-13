const trustCards = [
  {
    title: "Retrieval-first architecture",
    description:
      "Answers are generated only from retrieved judgment text. The AI does not draw on general training data for legal conclusions. Every cited case is a real case in our database.",
  },
  {
    title: "No training on your queries",
    description:
      "Your legal research is confidential. NyayaSearch does not use your queries or the AI's responses to train or fine-tune any model. Your work product remains yours.",
  },
  {
    title: "Transparent when uncertain",
    description:
      "When the database does not contain sufficient authority to answer a question, NyayaSearch says so clearly rather than generating a speculative response. Silence is more useful than fabrication.",
  },
];

export default function TrustSection() {
  return (
    <section className="bg-ivory-50 py-24 sm:py-32 border-t border-ivory-200">
      <div className="max-w-[1200px] mx-auto px-6 sm:px-8">
        {/* Section header */}
        <div className="max-w-3xl">
          <span className="overline">Why advocates trust NyayaSearch</span>
          <h2 className="mt-6 font-serif text-4xl sm:text-[44px] leading-[1.1] tracking-tight text-charcoal-900">
            The difference between a citation and a fabrication is everything.
          </h2>
          <div className="mt-8 max-w-2xl space-y-5 text-[17px] text-charcoal-600 leading-relaxed">
            <p>
              General-purpose AI tools generate plausible-sounding legal text.
              They invent case names, fabricate holdings, and cite judgments that
              do not exist. For a practising advocate, a single false citation is
              not just unhelpful — it is professionally dangerous.
            </p>
            <p>
              NyayaSearch is architecturally different. Every answer is generated
              through retrieval-augmented generation: the system first searches a
              curated database of real Supreme Court and High Court judgments,
              retrieves the relevant passages, and only then generates a response
              grounded in those actual sources. If the database does not contain
              a relevant judgment, the system says so.
            </p>
          </div>
        </div>

        {/* Trust cards */}
        <div className="mt-16 grid md:grid-cols-3 gap-6">
          {trustCards.map((card) => (
            <div
              key={card.title}
              className="bg-ivory-100 border border-ivory-200 rounded-xl p-7"
            >
              <h3 className="mt-5 font-serif text-[22px] text-charcoal-900 leading-snug">
                {card.title}
              </h3>
              <p className="mt-3 text-[14px] text-charcoal-600 leading-relaxed">
                {card.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
