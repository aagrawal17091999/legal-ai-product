const steps = [
  {
    number: "01",
    title: "Set Your Filters",
    description:
      "Choose the court, judge, year range, and case type to narrow your search to what matters.",
  },
  {
    number: "02",
    title: "Ask Your Question",
    description:
      "Type your legal research question in plain language — just like asking a senior colleague.",
  },
  {
    number: "03",
    title: "Get Cited Answers",
    description:
      "Receive AI-powered answers grounded in real case law, with full citations and links to judgments.",
  },
];

export default function HowItWorks() {
  return (
    <section className="py-20 bg-slate-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold text-slate-900">How It Works</h2>
          <p className="mt-4 text-lg text-slate-600">
            Three steps to faster, more reliable legal research.
          </p>
        </div>
        <div className="grid md:grid-cols-3 gap-8">
          {steps.map((step) => (
            <div key={step.number} className="text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary-100 text-primary-600 font-bold text-lg mb-4">
                {step.number}
              </div>
              <h3 className="text-lg font-semibold text-slate-900 mb-2">
                {step.title}
              </h3>
              <p className="text-slate-600">{step.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
