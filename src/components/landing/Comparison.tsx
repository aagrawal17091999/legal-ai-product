const rows: [string, boolean | string, boolean | string, boolean | string][] = [
  [
    "Answers legal questions",
    "Sometimes accurately",
    "Returns documents, not answers",
    "Cited, grounded answers",
  ],
  [
    "Cites real judgments",
    "Frequently fabricates",
    true,
    "Every citation links to source PDF",
  ],
  [
    "Understands Indian law",
    "Partial, unreliable",
    "Comprehensive databases",
    "Built exclusively for Indian case law",
  ],
  [
    "Saves research time",
    "Fast but unverifiable",
    "Hours of manual reading",
    "Minutes, with verifiable sources",
  ],
  [
    "Pre-filters by court, judge, act",
    false,
    "Varies by platform",
    "10+ filter dimensions",
  ],
  ["Free to start", true, false, "5 free queries per day"],
];

function Cell({ value, accent }: { value: boolean | string; accent?: boolean }) {
  if (value === true) {
    return (
      <svg
        className={`w-5 h-5 ${accent ? "text-gold-500" : "text-teal-600"}`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    );
  }
  if (value === false) {
    return (
      <svg
        className="w-5 h-5 text-charcoal-400"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    );
  }
  return (
    <span
      className={`text-[14px] leading-snug ${
        accent ? "text-charcoal-900 font-medium" : "text-charcoal-600"
      }`}
    >
      {value}
    </span>
  );
}

export default function Comparison() {
  return (
    <section className="bg-ivory-100 py-24 sm:py-32 border-t border-ivory-200">
      <div className="max-w-[1200px] mx-auto px-6 sm:px-8">
        <div className="max-w-2xl mb-14">
          <span className="overline">The difference</span>
          <h2 className="mt-6 font-serif text-4xl sm:text-[44px] leading-[1.1] tracking-tight text-charcoal-900">
            Not another chatbot. Not another keyword search.
          </h2>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse bg-ivory-50 border border-ivory-200 rounded-xl overflow-hidden">
            <thead>
              <tr className="border-b border-ivory-200">
                <th className="text-left px-6 py-5 text-[13px] font-medium uppercase tracking-wider text-charcoal-400">
                  {" "}
                </th>
                <th className="text-left px-6 py-5 text-[13px] font-medium uppercase tracking-wider text-charcoal-600">
                  Generic AI
                </th>
                <th className="text-left px-6 py-5 text-[13px] font-medium uppercase tracking-wider text-charcoal-600">
                  Manual research
                </th>
                <th className="text-left px-6 py-5 text-[13px] font-medium uppercase tracking-wider text-gold-600">
                  NyayaSearch
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, a, b, c]) => (
                <tr
                  key={label}
                  className="border-b border-ivory-200 last:border-b-0"
                >
                  <td className="px-6 py-5 text-[14px] text-charcoal-900 font-medium">
                    {label}
                  </td>
                  <td className="px-6 py-5">
                    <Cell value={a} />
                  </td>
                  <td className="px-6 py-5">
                    <Cell value={b} />
                  </td>
                  <td className="px-6 py-5 bg-gold-100/40">
                    <Cell value={c} accent />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
