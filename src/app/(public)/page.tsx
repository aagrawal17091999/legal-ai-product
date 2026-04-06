import Hero from "@/components/landing/Hero";
import HowItWorks from "@/components/landing/HowItWorks";
import Features from "@/components/landing/Features";
import Link from "next/link";
import Button from "@/components/ui/Button";

export default function LandingPage() {
  return (
    <>
      <Hero />
      <HowItWorks />
      <Features />

      {/* Pricing CTA */}
      <section className="py-20 bg-slate-50">
        <div className="max-w-3xl mx-auto px-4 text-center">
          <h2 className="text-3xl font-bold text-slate-900">
            Start Researching Today
          </h2>
          <p className="mt-4 text-lg text-slate-600">
            Free to start with 5 queries per day. Upgrade to Pro for unlimited
            access.
          </p>
          <div className="mt-8 flex justify-center gap-4">
            <Link href="/signup">
              <Button size="lg">Get Started Free</Button>
            </Link>
            <Link href="/pricing">
              <Button variant="outline" size="lg">
                View Plans
              </Button>
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
