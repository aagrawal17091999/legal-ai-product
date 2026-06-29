// Stub Terms of Service. Placeholder template text — NOT legal advice and not a
// substitute for reviewed terms. TODO: replace with lawyer-reviewed terms.
const LAST_UPDATED = "28 June 2026";

export default function TermsPage() {
  return (
    <section className="bg-ivory-50 py-24 sm:py-32">
      <div className="max-w-3xl mx-auto px-6 sm:px-8">
        <span className="overline">Legal</span>
        <h1 className="mt-6 font-serif text-5xl sm:text-[56px] leading-[1.05] tracking-tight text-charcoal-900">
          Terms of Service.
        </h1>
        <p className="mt-6 text-[14px] text-charcoal-400">Last updated: {LAST_UPDATED}</p>

        <div className="mt-6 rounded-lg border border-gold-400 bg-gold-100/50 px-4 py-3">
          <p className="text-[13px] text-charcoal-700 leading-relaxed">
            <span className="font-semibold">Template notice.</span> This is
            placeholder text and not a finalised legal document. It will be
            replaced with reviewed Terms of Service before launch.
          </p>
        </div>

        <div className="mt-10 space-y-6 text-[15px] text-charcoal-600 leading-relaxed">
          <p>
            By using Legal Brain you agree to use the service lawfully and only
            for legitimate legal research and document workflows. You are
            responsible for the content you upload and for confirming you have
            the right to process it.
          </p>
          <p>
            Legal Brain is a research and document tool and does not provide
            legal advice. AI-generated output — including translations, OCR, and
            answers — must be reviewed by a qualified professional before you
            rely on it.
          </p>
          <p>
            The service is provided on an &ldquo;as is&rdquo; basis. To the
            extent permitted by law, we disclaim warranties and limit our
            liability for use of the service.
          </p>
          <p>
            Questions about these terms? Contact us at{" "}
            <a href="mailto:hello@nyayasearch.com" className="text-gold-600 hover:text-gold-700">
              hello@nyayasearch.com
            </a>.
          </p>
        </div>
      </div>
    </section>
  );
}
