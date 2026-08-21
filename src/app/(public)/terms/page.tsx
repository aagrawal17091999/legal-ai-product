// Terms of Service — DRAFT PENDING ANSH'S REVIEW.
//
// Substantive draft written against how the product actually bills and behaves
// (credit pool, GST on top, 30-day audit retention, AI output disclaimers), not
// boilerplate. Needs a read-through before launch.
//
// TO PUBLISH: confirm every ⟨CONFIRM⟩ marker, then delete the REVIEW_PENDING
// banner. Do not remove the banner first — it is what stops an unreviewed
// document from reading as a finalised contract.
//
// ⟨CONFIRM⟩ items:
//   1. Legal entity name + registered address.
//   2. Governing law / jurisdiction city (drafted as India; city left open).
//   3. Refund policy specifics — Razorpay requires a published policy, and the
//      wording below must match what you will actually honour.
//   4. Whether you want a liability cap other than "fees paid in the last 12
//      months".
const LAST_UPDATED = "11 August 2026";
const REVIEW_PENDING = true;

export default function TermsPage() {
  return (
    <section className="bg-ivory-50 py-24 sm:py-32">
      <div className="max-w-3xl mx-auto px-6 sm:px-8">
        <span className="overline">Legal</span>
        <h1 className="mt-6 font-serif text-5xl sm:text-[56px] leading-[1.05] tracking-tight text-charcoal-900">
          Terms of Service.
        </h1>
        <p className="mt-6 text-[14px] text-charcoal-400">Last updated: {LAST_UPDATED}</p>

        {REVIEW_PENDING && (
          <div className="mt-6 rounded-lg border border-gold-400 bg-gold-100/50 px-4 py-3">
            <p className="text-[13px] text-charcoal-700 leading-relaxed">
              <span className="font-semibold">Under review.</span> These terms are
              complete in substance but are still being reviewed. If anything here
              matters to a decision you are making, please contact us first.
            </p>
          </div>
        )}

        <div className="mt-10 space-y-8 text-[15px] text-charcoal-600 leading-relaxed">
          <div className="rounded-lg border border-ivory-200 bg-ivory-100 px-5 py-4">
            <p className="text-charcoal-900 font-medium">
              Legal Brain is a research tool, not a lawyer.
            </p>
            <p className="mt-2">
              It does not provide legal advice and no advocate–client relationship
              arises from using it. AI output can be wrong, incomplete, or out of
              date. Verify every citation against the source judgment before you
              rely on it, and have a qualified human review any translation before
              filing. You remain professionally responsible for your work.
            </p>
          </div>

          <div>
            <h2 className="font-serif text-2xl text-charcoal-900 mb-3">
              Using the service
            </h2>
            <p>
              You must be legally able to enter a contract and use Legal Brain
              only for lawful legal research and document work. Your account is
              yours alone — do not share credentials. You are responsible for the
              content you upload and for confirming you have the right to process
              it, including any client confidentiality obligations that attach to
              it.
            </p>
            <p className="mt-3">
              Do not attempt to scrape or bulk-export the judgment corpus, resell
              access, reverse-engineer the service, or use it to build a competing
              dataset.
            </p>
          </div>

          <div>
            <h2 className="font-serif text-2xl text-charcoal-900 mb-3">
              Plans, credits, and payment
            </h2>
            <ul className="space-y-2 list-disc pl-5">
              <li>
                Work is billed in <span className="font-medium text-charcoal-900">credits</span>.
                Every action — a research question, a document chat, a page of
                translation or OCR — consumes credits in proportion to the
                processing it requires.
              </li>
              <li>
                A free account receives a one-time allowance of 200 credits. It
                does not reset.
              </li>
              <li>
                Pro includes 1,000 credits per month. Monthly credits do not roll
                over; they reset at the start of each monthly period.
              </li>
              <li>
                Top-up credits can be bought at any time. They do not expire, and
                are used only after your monthly plan credits are exhausted.
              </li>
              <li>
                When your balance reaches zero, new work is paused until you top
                up. Work already completed remains available.
              </li>
              <li>
                All prices are exclusive of GST, which is charged in addition at
                the applicable rate on both subscriptions and top-ups.
              </li>
              <li>
                Subscriptions renew automatically until cancelled. Cancelling
                stops future renewals; access continues to the end of the period
                you have paid for.
              </li>
            </ul>
          </div>

          <div>
            <h2 className="font-serif text-2xl text-charcoal-900 mb-3">Refunds</h2>
            <p>
              If the service fails to deliver work you were charged for, contact
              us and we will refund the credits consumed. Beyond that,
              subscription fees are generally non-refundable once a billing period
              has begun, and credits already consumed cannot be refunded. Nothing
              here limits any right you have under consumer law.
            </p>
          </div>

          <div>
            <h2 className="font-serif text-2xl text-charcoal-900 mb-3">
              Your content
            </h2>
            <p>
              You keep all rights to what you upload. You grant us only the
              permission needed to run the service on it — storing it, extracting
              text, indexing it for search, and sending the necessary parts to the
              AI providers listed in our Privacy Policy. We do not use your
              content to train AI models. You can delete your content at any time.
            </p>
          </div>

          <div>
            <h2 className="font-serif text-2xl text-charcoal-900 mb-3">
              Availability
            </h2>
            <p>
              We aim to keep the service available but do not guarantee
              uninterrupted access. Features may change, and we may suspend
              accounts that abuse the service or fail to pay. Long-running jobs
              such as OCR and translation are processed in the background and
              completion times vary with document size and load.
            </p>
          </div>

          <div>
            <h2 className="font-serif text-2xl text-charcoal-900 mb-3">
              Liability
            </h2>
            <p>
              To the extent permitted by law, Legal Brain is provided as is, and
              we are not liable for indirect or consequential loss, or for any
              outcome arising from reliance on AI-generated output that was not
              independently verified. Our total liability is limited to the fees
              you paid in the twelve months before the claim. Nothing here
              excludes liability that cannot lawfully be excluded.
            </p>
          </div>

          <div>
            <h2 className="font-serif text-2xl text-charcoal-900 mb-3">
              Changes and governing law
            </h2>
            <p>
              We may update these terms; material changes will be notified in the
              app or by email, and continued use after that constitutes
              acceptance. These terms are governed by the laws of India.
            </p>
          </div>

          <div>
            <h2 className="font-serif text-2xl text-charcoal-900 mb-3">Contact</h2>
            <p>
              Questions about these terms:{" "}
              <a
                href="mailto:ansh@getlegalbrain.com"
                className="text-gold-600 hover:text-gold-700"
              >
                ansh@getlegalbrain.com
              </a>
              .
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
