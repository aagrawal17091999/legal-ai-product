import Link from "next/link";
import Image from "next/image";

export default function Footer() {
  return (
    <footer className="bg-navy-950 text-ivory-50">
      <div className="max-w-[1200px] mx-auto px-6 sm:px-8 py-16">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-10">
          {/* Tagline column */}
          <div className="col-span-2">
            <Link href="/" className="flex items-center gap-2.5">
              <Image
                src="/logo.png"
                alt="Legal Brain"
                width={242}
                height={256}
                className="h-10 w-auto"
              />
              <span className="flex items-baseline gap-1">
                <span className="font-serif text-3xl text-ivory-50 leading-none">
                  Legal
                </span>
                <span className="text-xl text-ivory-50 tracking-tight">
                  Brain
                </span>
              </span>
            </Link>
            <p className="mt-5 font-serif text-xl text-ivory-50 max-w-sm leading-snug">
              The AI workspace for Indian lawyers — research, document Q&amp;A,
              translation, and OCR.
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
                  href="mailto:ansh@getlegalbrain.com"
                  className="text-sm text-ivory-50/80 hover:text-gold-500 transition-colors"
                >
                  ansh@getlegalbrain.com
                </a>
              </li>
              <li>
                <Link
                  href="/privacy"
                  className="text-sm text-ivory-50/80 hover:text-gold-500 transition-colors"
                >
                  Privacy Policy
                </Link>
              </li>
              <li>
                <Link
                  href="/terms"
                  className="text-sm text-ivory-50/80 hover:text-gold-500 transition-colors"
                >
                  Terms of Service
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <hr className="mt-16 border-0 border-t border-white/10" />
        <p className="mt-6 text-[13px] text-charcoal-400 text-center">
          © {new Date().getFullYear()} Legal Brain. All rights reserved.
          Legal Brain is a legal research and document tool and does not provide
          legal advice.
        </p>
      </div>
    </footer>
  );
}
