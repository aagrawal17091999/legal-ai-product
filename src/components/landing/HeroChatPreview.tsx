export function HeroChatPreview() {
  return (
    <div className="bg-ivory-50 rounded-2xl p-6 border border-white/10 shadow-2xl shadow-black/20 max-w-lg mx-auto lg:mx-0 w-full">
      {/* Header strip */}
      <div className="flex items-center gap-2.5 pb-4 border-b border-ivory-200 mb-4">
        <div className="w-2.5 h-2.5 rounded-full bg-gold-500" />
        <div className="text-[13px] text-charcoal-600 tracking-wider uppercase font-sans">
          New Research Session
        </div>
      </div>

      {/* User query bubble */}
      <div className="bg-ivory-100 rounded-lg px-4 py-3 mb-4">
        <p className="text-sm text-charcoal-900 leading-relaxed font-sans">
          What is the position on anticipatory bail in economic offences?
        </p>
      </div>

      {/* Streaming AI response */}
      <p className="text-sm text-charcoal-900 leading-[1.7] mb-4 font-sans">
        The Supreme Court has consistently held that anticipatory bail in economic
        offences requires careful balancing of personal liberty and the gravity of
        the offence
        <sup className="text-gold-500 font-medium">[1]</sup>. In{' '}
        <em>P. Chidambaram v. Directorate of Enforcement</em>, the Court emphasised
        that economic offences constitute a class apart
        <sup className="text-gold-500 font-medium">[2]</sup>, warranting a stricter
        approach
        <span className="inline-block w-[8px] h-[16px] bg-charcoal-900 align-middle ml-0.5 animate-pulse" />
      </p>

      {/* Cited judgments footer */}
      <div className="border-t border-ivory-200 pt-4">
        <div className="text-xs text-charcoal-600 uppercase tracking-wider font-sans mb-2.5">
          Cited Judgments
        </div>
        <div className="space-y-2">
          <div className="bg-gold-100 border-l-2 border-gold-500 rounded-r-md py-2.5 px-3">
            <div className="font-serif italic text-sm text-charcoal-900">
              P. Chidambaram v. Directorate of Enforcement
            </div>
            <div className="font-mono text-xs text-charcoal-600 mt-0.5">
              (2019) 9 SCC 24 · Supreme Court
            </div>
          </div>
          <div className="bg-gold-100 border-l-2 border-gold-500 rounded-r-md py-2.5 px-3">
            <div className="font-serif italic text-sm text-charcoal-900">
              Y.S. Jagan Mohan Reddy v. CBI
            </div>
            <div className="font-mono text-xs text-charcoal-600 mt-0.5">
              (2013) 7 SCC 439 · Supreme Court
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
