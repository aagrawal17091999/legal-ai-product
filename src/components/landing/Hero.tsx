import Link from "next/link";
import Button from "@/components/ui/Button";
import { HeroChatPreview } from "@/components/landing/HeroChatPreview";

export default function Hero() {
  return (
    <section className="bg-navy-950 text-ivory-50 relative overflow-hidden">
      <div className="px-6 sm:px-8 pt-28 pb-32 sm:pt-36 sm:pb-40">
        <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_1fr] gap-16 items-center max-w-7xl mx-auto">
          {/* Left column — existing copy */}
          <div className="max-w-3xl">
            <span className="overline">
              AI-Powered Legal Research for Indian Advocates
            </span>

            {/* Headline */}
            <h1 className="mt-8 font-serif text-[44px] sm:text-6xl lg:text-[72px] leading-[1.05] tracking-tight text-ivory-50">
              Research grounded in
              <br />
              the judgment, not
              <br />
              the imagination.
            </h1>

            {/* Subheadline */}
            <p className="mt-8 max-w-xl text-lg text-charcoal-400 leading-relaxed">
              Ask any question about Indian case law. Get cited, verifiable answers
              drawn from Supreme Court and High Court judgments — with every source
              linked to the original PDF.
            </p>

            {/* CTAs */}
            <div className="mt-10 flex flex-col sm:flex-row items-start sm:items-center gap-4">
              <Link href="/signup">
                <Button variant="primaryOnDark" size="lg">
                  Start Researching Free →
                </Button>
              </Link>
              <Link
                href="/#how-it-works"
                className="text-[15px] text-ivory-50 hover:text-gold-500 transition-colors px-2 py-2"
              >
                See How It Works →
              </Link>
            </div>

            {/* Trust line */}
            <p className="mt-8 text-sm text-charcoal-400">
              Free plan includes 5 queries per day. No credit card required.
            </p>
          </div>

          {/* Right column — chat preview */}
          <div className="mt-12 max-w-lg mx-auto lg:mt-0">
            <HeroChatPreview />
          </div>
        </div>
      </div>
    </section>
  );
}
