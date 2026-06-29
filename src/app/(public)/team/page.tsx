export default function TeamPage() {
  return (
    <section className="bg-ivory-50 py-24 sm:py-32">
      <div className="max-w-[1200px] mx-auto px-6 sm:px-8">
        <div className="max-w-2xl">
          <span className="overline">About</span>
          <h1 className="mt-6 font-serif text-5xl sm:text-[56px] leading-[1.05] tracking-tight text-charcoal-900">
            About us.
          </h1>
          {/* TODO: replace with real team bios once finalised. Fake placeholder
              "Team Member" cards were removed so they don't ship. */}
          <p className="mt-8 text-[17px] text-charcoal-600 leading-relaxed">
            Legal Brain is built by a small team focused on making Indian legal
            research faster and more reliable — combining a comprehensive
            judgment library with AI that cites its sources. We pair tooling for
            document Q&amp;A, translation, and OCR with a strong bias toward
            accuracy: the assistant tells you when something isn&apos;t in the
            record rather than guessing.
          </p>
          <p className="mt-5 text-[17px] text-charcoal-600 leading-relaxed">
            Want to get in touch?{" "}
            <a
              href="mailto:hello@nyayasearch.com"
              className="text-gold-600 hover:text-gold-700"
            >
              hello@nyayasearch.com
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}
