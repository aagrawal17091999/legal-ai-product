// Stub Privacy Policy. Placeholder template text — NOT legal advice and not a
// substitute for a reviewed policy. TODO: replace with a lawyer-reviewed policy.
const LAST_UPDATED = "28 June 2026";

export default function PrivacyPage() {
  return (
    <section className="bg-ivory-50 py-24 sm:py-32">
      <div className="max-w-3xl mx-auto px-6 sm:px-8">
        <span className="overline">Legal</span>
        <h1 className="mt-6 font-serif text-5xl sm:text-[56px] leading-[1.05] tracking-tight text-charcoal-900">
          Privacy Policy.
        </h1>
        <p className="mt-6 text-[14px] text-charcoal-400">Last updated: {LAST_UPDATED}</p>

        <div className="mt-6 rounded-lg border border-gold-400 bg-gold-100/50 px-4 py-3">
          <p className="text-[13px] text-charcoal-700 leading-relaxed">
            <span className="font-semibold">Template notice.</span> This is
            placeholder text and not a finalised legal document. It will be
            replaced with a reviewed Privacy Policy before launch.
          </p>
        </div>

        <div className="mt-10 space-y-6 text-[15px] text-charcoal-600 leading-relaxed">
          <p>
            Legal Brain collects the information you provide when you create an
            account and use the service — including documents you upload for
            analysis, translation, or OCR, and the queries you run. We use this
            information to operate and improve the product.
          </p>
          <p>
            We do not sell your personal data. Documents you upload are
            processed to deliver the features you request and are retained only
            as long as needed to provide the service or as required by law.
          </p>
          <p>
            Third-party processors (for example, payment and infrastructure
            providers) may process limited data on our behalf under appropriate
            agreements.
          </p>
          <p>
            For questions about this policy or to request deletion of your data,
            contact us at{" "}
            <a href="mailto:hello@nyayasearch.com" className="text-gold-600 hover:text-gold-700">
              hello@nyayasearch.com
            </a>.
          </p>
        </div>
      </div>
    </section>
  );
}
