import Link from "next/link";

export default function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 mb-3">
              Product
            </h3>
            <ul className="space-y-2">
              <li>
                <Link
                  href="/pricing"
                  className="text-sm text-slate-500 hover:text-slate-700"
                >
                  Pricing
                </Link>
              </li>
              <li>
                <Link
                  href="/chat"
                  className="text-sm text-slate-500 hover:text-slate-700"
                >
                  Search Cases
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-900 mb-3">
              Company
            </h3>
            <ul className="space-y-2">
              <li>
                <Link
                  href="/team"
                  className="text-sm text-slate-500 hover:text-slate-700"
                >
                  Team
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-900 mb-3">
              Legal
            </h3>
            <ul className="space-y-2">
              <li>
                <span className="text-sm text-slate-400">Terms of Service</span>
              </li>
              <li>
                <span className="text-sm text-slate-400">Privacy Policy</span>
              </li>
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-900 mb-3">
              Contact
            </h3>
            <ul className="space-y-2">
              <li>
                <span className="text-sm text-slate-400">
                  support@nyayasearch.com
                </span>
              </li>
            </ul>
          </div>
        </div>
        <div className="mt-8 pt-8 border-t border-slate-200">
          <p className="text-sm text-slate-400 text-center">
            &copy; {new Date().getFullYear()} NyayaSearch. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
