const team = [
  {
    name: "Team Member 1",
    role: "Founder & CEO",
    bio: "Passionate about making legal research accessible through technology.",
  },
  {
    name: "Team Member 2",
    role: "CTO",
    bio: "Building the AI infrastructure that powers NyayaSearch.",
  },
  {
    name: "Team Member 3",
    role: "Head of Legal",
    bio: "Ensuring our product meets the needs of legal professionals.",
  },
];

export default function TeamPage() {
  return (
    <section className="bg-ivory-50 py-24 sm:py-32">
      <div className="max-w-[1200px] mx-auto px-6 sm:px-8">
        <div className="max-w-2xl">
          <span className="overline">About</span>
          <h1 className="mt-6 font-serif text-5xl sm:text-[56px] leading-[1.05] tracking-tight text-charcoal-900">
            Our team.
          </h1>
          <p className="mt-6 text-[17px] text-charcoal-600 leading-relaxed">
            The people behind NyayaSearch.
          </p>
        </div>

        <div className="mt-16 grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {team.map((member) => (
            <div
              key={member.name}
              className="bg-ivory-100 border border-ivory-200 rounded-xl p-8"
            >
              <div className="w-20 h-20 rounded-full bg-navy-950 text-ivory-50 flex items-center justify-center font-serif text-2xl">
                {member.name.split(" ").map((n) => n[0]).join("")}
              </div>
              <h3 className="mt-6 font-serif text-2xl text-charcoal-900">
                {member.name}
              </h3>
              <p className="mt-1 text-[13px] text-gold-600 font-medium uppercase tracking-wider">
                {member.role}
              </p>
              <p className="mt-4 text-[14px] text-charcoal-600 leading-relaxed">
                {member.bio}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
