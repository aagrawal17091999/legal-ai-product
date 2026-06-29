import Link from "next/link";

// App-wide 404. Styled on-brand; links back into the product.
export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-ivory-50 px-6 py-16">
      <div className="max-w-md text-center">
        <span className="overline">404</span>
        <h1 className="mt-5 font-serif text-4xl text-charcoal-900 tracking-tight">
          Page not found.
        </h1>
        <p className="mt-4 text-[15px] text-charcoal-600 leading-relaxed">
          The page you&apos;re looking for doesn&apos;t exist or may have moved.
        </p>
        <Link
          href="/chat"
          className="inline-block mt-8 rounded-lg bg-navy-950 text-ivory-50 px-5 py-2.5 text-[15px] font-medium hover:bg-navy-800 transition-colors"
        >
          Back to chat
        </Link>
      </div>
    </div>
  );
}
