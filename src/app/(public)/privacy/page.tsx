// Privacy Policy — DRAFT PENDING ANSH'S REVIEW.
//
// This is a substantive draft grounded in what the system actually does (see the
// sub-processor table below, which is derived from the real integrations), not
// boilerplate. It still needs a read-through before launch, because a wrong
// statement here is a compliance problem rather than a copy problem.
//
// TO PUBLISH: confirm every ⟨CONFIRM⟩ marker below, then delete the
// REVIEW_PENDING banner. Do not remove the banner before the review — its whole
// purpose is to stop an unreviewed policy from reading as a finalised one.
//
// ⟨CONFIRM⟩ items:
//   1. Hosting region of the Hetzner box (data-residency claim depends on it).
//   2. Legal entity name + registered address for the "who we are" line.
//   3. Whether a GST-registered business name must appear (Razorpay requirement).
//   4. Grievance Officer name + contact — required under India's DPDP Act.
const LAST_UPDATED = "11 August 2026";
const REVIEW_PENDING = true;

const SUBPROCESSORS: { name: string; purpose: string; data: string }[] = [
  {
    name: "Hetzner Online GmbH",
    purpose: "Servers and database hosting",
    data: "All account data, uploaded documents, and chat history",
  },
  {
    name: "Anthropic (Claude)",
    purpose: "Answering questions; structuring and translating documents",
    data: "Query text and the document excerpts needed to answer it",
  },
  {
    name: "Voyage AI",
    purpose: "Search indexing and relevance ranking",
    data: "Text extracted from your documents and your queries",
  },
  {
    name: "Sarvam AI",
    purpose: "Reading scanned documents (OCR) and translation",
    data: "Page images and extracted text from documents you upload",
  },
  {
    name: "Cloudflare R2",
    purpose: "File storage for uploads and generated output",
    data: "The documents you upload and the files we produce from them",
  },
  {
    name: "Google Firebase",
    purpose: "Sign-in and live job-status updates",
    data: "Email address, authentication tokens, job status",
  },
  {
    name: "Razorpay",
    purpose: "Payments",
    data: "Billing details you enter at checkout (we never see full card numbers)",
  },
];

export default function PrivacyPage() {
  return (
    <section className="bg-ivory-50 py-24 sm:py-32">
      <div className="max-w-3xl mx-auto px-6 sm:px-8">
        <span className="overline">Legal</span>
        <h1 className="mt-6 font-serif text-5xl sm:text-[56px] leading-[1.05] tracking-tight text-charcoal-900">
          Privacy Policy.
        </h1>
        <p className="mt-6 text-[14px] text-charcoal-400">Last updated: {LAST_UPDATED}</p>

        {REVIEW_PENDING && (
          <div className="mt-6 rounded-lg border border-gold-400 bg-gold-100/50 px-4 py-3">
            <p className="text-[13px] text-charcoal-700 leading-relaxed">
              <span className="font-semibold">Under review.</span> This policy is
              complete in substance but is still being reviewed. If anything here
              matters to a decision you are making, please contact us first.
            </p>
          </div>
        )}

        <div className="mt-10 space-y-8 text-[15px] text-charcoal-600 leading-relaxed">
          <p className="text-charcoal-700">
            You upload privileged client material to this service. This policy
            says plainly what happens to it, who else touches it, and how long we
            keep it.
          </p>

          <div>
            <h2 className="font-serif text-2xl text-charcoal-900 mb-3">
              What we collect
            </h2>
            <ul className="space-y-2 list-disc pl-5">
              <li>
                <span className="font-medium text-charcoal-900">Account details</span> —
                your email address, and a display name if you set one. Sign-in is
                handled by Firebase; we never store your password.
              </li>
              <li>
                <span className="font-medium text-charcoal-900">Documents you upload</span> —
                for document workspaces, translation, and OCR, along with the text
                we extract from them and the search index built over that text.
              </li>
              <li>
                <span className="font-medium text-charcoal-900">Your queries and chat history</span> —
                what you ask, the answers returned, and which judgments were cited.
              </li>
              <li>
                <span className="font-medium text-charcoal-900">Usage and billing records</span> —
                credits consumed per action, and payment records from Razorpay.
              </li>
              <li>
                <span className="font-medium text-charcoal-900">Diagnostics</span> —
                error reports, which may include a technical stack trace and the
                page you were on.
              </li>
            </ul>
          </div>

          <div>
            <h2 className="font-serif text-2xl text-charcoal-900 mb-3">
              How we use it
            </h2>
            <p>
              To operate the features you ask for, to bill you accurately, and to
              diagnose faults. That is the whole list.
            </p>
            <p className="mt-3 font-medium text-charcoal-900">
              We do not sell your data. We do not use your documents or queries to
              train AI models, and our AI providers are engaged on terms that do
              not permit them to either.
            </p>
          </div>

          <div>
            <h2 className="font-serif text-2xl text-charcoal-900 mb-3">
              Who else processes it
            </h2>
            <p className="mb-4">
              Delivering these features means sending parts of your content to the
              providers below. Each processes it only to perform its function for
              us.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-[14px] border-collapse">
                <thead>
                  <tr className="border-b border-ivory-200 text-left">
                    <th className="py-2 pr-4 font-medium text-charcoal-900">Provider</th>
                    <th className="py-2 pr-4 font-medium text-charcoal-900">Purpose</th>
                    <th className="py-2 font-medium text-charcoal-900">What it sees</th>
                  </tr>
                </thead>
                <tbody>
                  {SUBPROCESSORS.map((p) => (
                    <tr key={p.name} className="border-b border-ivory-200 align-top">
                      <td className="py-2.5 pr-4 text-charcoal-900">{p.name}</td>
                      <td className="py-2.5 pr-4">{p.purpose}</td>
                      <td className="py-2.5">{p.data}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <h2 className="font-serif text-2xl text-charcoal-900 mb-3">
              How long we keep it
            </h2>
            <ul className="space-y-2 list-disc pl-5">
              <li>
                <span className="font-medium text-charcoal-900">Documents and chat history</span> —
                kept until you delete them or close your account. Deleting a
                document or workspace removes the file and its extracted text.
              </li>
              <li>
                <span className="font-medium text-charcoal-900">Search-and-reasoning audit records</span> —
                automatically deleted after 30 days.
              </li>
              <li>
                <span className="font-medium text-charcoal-900">Error diagnostics</span> —
                deleted after 30 days.
              </li>
              <li>
                <span className="font-medium text-charcoal-900">Billing records</span> —
                retained as long as tax and accounting law requires, even after
                account closure.
              </li>
              <li>
                <span className="font-medium text-charcoal-900">Backups</span> —
                encrypted nightly backups may hold deleted content briefly until
                they age out.
              </li>
            </ul>
          </div>

          <div>
            <h2 className="font-serif text-2xl text-charcoal-900 mb-3">
              Your rights
            </h2>
            <p>
              You can access, correct, export, or delete your data. Deleting a
              document or workspace takes effect immediately in the app. To delete
              your account and everything in it, email us and we will action it.
            </p>
          </div>

          <div>
            <h2 className="font-serif text-2xl text-charcoal-900 mb-3">Security</h2>
            <p>
              Traffic is encrypted in transit. Uploaded files are stored in
              private object storage and served only through short-lived links
              scoped to your account. Backups are encrypted. No system is immune
              to compromise; if a breach affects your data we will tell you.
            </p>
          </div>

          <div>
            <h2 className="font-serif text-2xl text-charcoal-900 mb-3">Contact</h2>
            <p>
              For any privacy question, or to request deletion of your data,
              contact{" "}
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
