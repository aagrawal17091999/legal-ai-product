import Hero from "@/components/landing/Hero";
import SocialProof from "@/components/landing/SocialProof";
import HowItWorks from "@/components/landing/HowItWorks";
import Features from "@/components/landing/Features";
import TrustSection from "@/components/landing/TrustSection";
import Comparison from "@/components/landing/Comparison";
import PricingTeaser from "@/components/landing/PricingTeaser";
import FAQ from "@/components/landing/FAQ";
import FinalCTA from "@/components/landing/FinalCTA";
import RedirectIfAuthed from "@/components/landing/RedirectIfAuthed";

export default function LandingPage() {
  return (
    <>
      <RedirectIfAuthed />
      <Hero />
      <SocialProof />
      <HowItWorks />
      <Features />
      <TrustSection />
      <Comparison />
      <PricingTeaser />
      <FAQ />
      <FinalCTA />
    </>
  );
}
