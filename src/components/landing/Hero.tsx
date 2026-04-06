import Link from "next/link";
import Button from "@/components/ui/Button";

export default function Hero() {
  return (
    <section className="py-20 sm:py-32">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-slate-900 tracking-tight">
          Legal Research,
          <br />
          <span className="text-primary-600">Powered by AI</span>
        </h1>
        <p className="mt-6 max-w-2xl mx-auto text-lg text-slate-600">
          Search across Indian Supreme Court and High Court judgments. Get
          AI-powered answers grounded in real case law — with citations you can
          verify.
        </p>
        <div className="mt-10 flex items-center justify-center gap-4">
          <Link href="/signup">
            <Button size="lg">Start Searching — Free</Button>
          </Link>
          <Link href="/pricing">
            <Button variant="outline" size="lg">
              View Pricing
            </Button>
          </Link>
        </div>
      </div>
    </section>
  );
}
