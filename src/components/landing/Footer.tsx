import Link from "next/link";

export default function Footer() {
  return (
    <footer className="bg-navy-950 text-ivory-50">
      <div className="max-w-[1200px] mx-auto px-6 sm:px-8 py-16">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-10">
          {/* Tagline column */}
          <div className="col-span-2">
            <Link href="/" className="flex items-baseline gap-1">
              <span className="font-serif text-3xl text-ivory-50 leading-none">
                Nyaya
              </span>
              <span className="text-xl text-ivory-50 tracking-tight">
                Search
              </span>
            </Link>
            <p className="mt-5 font-serif text-xl text-ivory-50 max-w-sm leading-snug">
              Legal research grounded in real judgments.
            </p>
          </div>

          <div>
            <h3 className="text-[13px] font-medium text-charcoal-400 uppercase tracking-wider mb-4">
              Product
            </h3>
            <ul className="space-y-3">
              <li>
                <Link
                  href="/#features"
                  className="text-sm text-ivory-50/80 hover:text-gold-500 transition-colors"
                >
                  Features
                </Link>
              </li>
              <li>
                <Link
                  href="/#pricing"
                  className="text-sm text-ivory-50/80 hover:text-gold-500 transition-colors"
                >
                  Pricing
                </Link>
              </li>
              <li>
                <Link
                  href="/judgments"
                  className="text-sm text-ivory-50/80 hover:text-gold-500 transition-colors"
                >
                  Judgment Library
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h3 className="text-[13px] font-medium text-charcoal-400 uppercase tracking-wider mb-4">
              Resources
            </h3>
            <ul className="space-y-3">
              <li>
                <Link
                  href="/#how-it-works"
                  className="text-sm text-ivory-50/80 hover:text-gold-500 transition-colors"
                >
                  How It Works
                </Link>
              </li>
              <li>
                <Link
                  href="/#faq"
                  className="text-sm text-ivory-50/80 hover:text-gold-500 transition-colors"
                >
                  FAQ
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h3 className="text-[13px] font-medium text-charcoal-400 uppercase tracking-wider mb-4">
              Company
            </h3>
            <ul className="space-y-3">
              <li>
                <Link
                  href="/team"
                  className="text-sm text-ivory-50/80 hover:text-gold-500 transition-colors"
                >
                  About
                </Link>
              </li>
              <li>
                <a
                  href="mailto:hello@nyayasearch.com"
                  className="text-sm text-ivory-50/80 hover:text-gold-500 transition-colors"
                >
                  hello@nyayasearch.com
                </a>
              </li>
              <li>
                <span className="text-sm text-charcoal-400">
                  Privacy Policy
                </span>
              </li>
              <li>
                <span className="text-sm text-charcoal-400">
                  Terms of Service
                </span>
              </li>
            </ul>
          </div>
        </div>

        <hr className="mt-16 border-0 border-t border-white/10" />
        <p className="mt-6 text-[13px] text-charcoal-400 text-center">
          © {new Date().getFullYear()} NyayaSearch. All rights reserved.
          NyayaSearch is a legal research tool and does not provide legal advice.
        </p>
      </div>
    </footer>
  );
}
