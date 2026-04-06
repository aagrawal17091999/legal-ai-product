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
    <div className="py-20">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <h1 className="text-4xl font-bold text-slate-900">Our Team</h1>
          <p className="mt-4 text-lg text-slate-600">
            The people behind NyayaSearch.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-8">
          {team.map((member) => (
            <div
              key={member.name}
              className="text-center p-6 rounded-lg border border-slate-200"
            >
              <div className="w-24 h-24 rounded-full bg-slate-200 mx-auto mb-4 flex items-center justify-center">
                <svg
                  className="w-12 h-12 text-slate-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"
                  />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-slate-900">
                {member.name}
              </h3>
              <p className="text-sm text-primary-600 font-medium">
                {member.role}
              </p>
              <p className="mt-2 text-sm text-slate-500">{member.bio}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
