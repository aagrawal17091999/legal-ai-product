import Link from "next/link";
import Button from "@/components/ui/Button";

export default function FinalCTA() {
  return (
    <section className="bg-navy-950 text-ivory-50 py-28 sm:py-36">
      <div className="max-w-[1200px] mx-auto px-6 sm:px-8 text-center">
        <h2 className="font-serif text-4xl sm:text-[48px] leading-[1.1] tracking-tight text-ivory-50 max-w-3xl mx-auto">
          Your next brief deserves better research.
        </h2>
        <p className="mt-6 max-w-xl mx-auto text-[17px] text-charcoal-400 leading-relaxed">
          Join the advocates who have stopped guessing and started citing. Start
          with five free queries today.
        </p>
        <div className="mt-10 flex flex-col items-center gap-4">
          <Link href="/signup">
            <Button variant="primaryOnDark" size="lg">
              Create Free Account →
            </Button>
          </Link>
          <p className="text-sm text-charcoal-400">
            No credit card required. Ready in under a minute.
          </p>
        </div>
      </div>
    </section>
  );
}
