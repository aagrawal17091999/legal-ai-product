const steps = [
  {
    number: "01",
    title: "Ask in plain English",
    description:
      "Describe your legal question the way you would explain it to a colleague. No boolean operators, no keyword syntax. NyayaSearch understands legal intent — whether you ask about maintenance under Section 125 CrPC or the applicability of res judicata in writ proceedings.",
  },
  {
    number: "02",
    title: "Filter with precision",
    description:
      "Narrow your research by court, bench, judge, act cited, case category, year range, or specific parties. Combine filters to target exactly the line of authority you need — such as all Supreme Court decisions by a three-judge bench interpreting Article 21 after 2015.",
  },
  {
    number: "03",
    title: "Read answers grounded in judgments",
    description:
      "Every response streams in real time with inline citations linked to the source judgment. Click any citation to open the relevant passage. Download the full judgment PDF for your records, your brief, or your filing.",
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
            From question to cited answer in under sixty seconds.
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
