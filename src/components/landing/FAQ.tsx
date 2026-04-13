"use client";

import { useState } from "react";

const faqs = [
  {
    q: "Does NyayaSearch hallucinate or invent case citations?",
    a: "NyayaSearch uses retrieval-augmented generation (RAG), which means every answer is grounded in actual judgment text retrieved from our database. The AI does not generate case names, citations, or holdings from its general training data. Every inline citation links to the real source judgment. If the database does not contain a relevant judgment for your query, the system will indicate that the available authority is limited rather than fabricate an answer.",
  },
  {
    q: "How is this different from asking ChatGPT a legal question?",
    a: "ChatGPT and similar general-purpose AI tools have no verified legal database. They generate responses from patterns in training data, which frequently results in invented case names, fabricated holdings, and citations to judgments that do not exist. NyayaSearch searches a curated database of actual Supreme Court and High Court judgments first, then generates an answer grounded exclusively in those real documents. Every cited judgment is downloadable as a PDF.",
  },
  {
    q: "Which courts does NyayaSearch cover?",
    a: "NyayaSearch currently indexes judgments from the Supreme Court of India and High Courts across Indian states. Coverage is continuously expanding. If you need judgments from a specific High Court, contact us and we can confirm current coverage for that jurisdiction.",
  },
  {
    q: "Is my research data private? Do you train AI models on my queries?",
    a: "Your queries, your research sessions, and the AI responses generated for you are never used to train or fine-tune any AI model. Your data is stored securely and is accessible only to you. We use industry-standard encryption for data in transit and at rest.",
  },
  {
    q: "How accurate are the answers?",
    a: "Every factual claim in a NyayaSearch response is backed by an inline citation to a specific judgment. We encourage what we expect every responsible advocate already does: verify the cited source before relying on it. The citation links are designed to make this verification fast — one click to the relevant passage, one more to download the full PDF.",
  },
  {
    q: "How is this different from Manupatra or SCC Online?",
    a: "Manupatra and SCC Online are comprehensive legal databases — excellent for keyword search when you know what you are looking for. NyayaSearch is different in kind: you describe a legal question in plain language and receive a synthesised, cited answer drawn from case law. Think of it as the difference between searching a library catalogue and asking a research associate to brief you on the authorities.",
  },
  {
    q: "Is this compliant with Bar Council of India guidelines?",
    a: "NyayaSearch is a legal research tool that assists advocates in finding and reviewing case law. It does not provide legal advice, represent clients, or replace the professional judgment of a qualified advocate. Use of AI-assisted research tools is consistent with an advocate's professional duty to be thorough and well-prepared.",
  },
  {
    q: "What happens when my free queries run out for the day?",
    a: "The free plan includes 5 queries per day, which reset at midnight IST. If you need more, the Pro plan offers unlimited queries for ₹3,000 per month or ₹30,000 per year. You can upgrade instantly from your account settings.",
  },
  {
    q: "Can I cancel the Pro plan at any time?",
    a: "Yes. The monthly plan can be cancelled at any time and your access continues through the end of the billing period. The annual plan is paid upfront and provides access for the full year. No lock-in contracts, no cancellation fees.",
  },
];

export default function FAQ() {
  const [openIdx, setOpenIdx] = useState<number | null>(0);

  return (
    <section id="faq" className="bg-ivory-50 py-24 sm:py-32 border-t border-ivory-200">
      <div className="max-w-[1200px] mx-auto px-6 sm:px-8">
        <div className="max-w-3xl mb-14">
          <span className="overline">Frequently asked</span>
          <h2 className="mt-6 font-serif text-4xl sm:text-[44px] leading-[1.1] tracking-tight text-charcoal-900">
            Questions advocates ask before they start.
          </h2>
        </div>

        <div className="max-w-3xl divide-y divide-ivory-200 border-y border-ivory-200">
          {faqs.map((faq, idx) => {
            const isOpen = openIdx === idx;
            return (
              <div key={faq.q}>
                <button
                  type="button"
                  onClick={() => setOpenIdx(isOpen ? null : idx)}
                  className="w-full flex items-start justify-between gap-6 py-6 text-left group"
                  aria-expanded={isOpen}
                >
                  <span className="font-serif text-[22px] text-charcoal-900 leading-snug group-hover:text-gold-600 transition-colors">
                    {faq.q}
                  </span>
                  <span
                    className={`shrink-0 mt-1 text-gold-500 transition-transform ${
                      isOpen ? "rotate-45" : ""
                    }`}
                  >
                    <svg
                      className="w-6 h-6"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M12 4v16m8-8H4"
                      />
                    </svg>
                  </span>
                </button>
                {isOpen && (
                  <div className="pb-6 pr-10">
                    <p className="text-[15px] text-charcoal-600 leading-relaxed">
                      {faq.a}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
