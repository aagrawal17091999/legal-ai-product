"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import FilterPanel from "@/components/chat/FilterPanel";
import { useChatContext } from "../layout";
import type { SearchFilters } from "@/types";

export default function NewChatPage() {
  const { createSession, error } = useChatContext();
  const router = useRouter();

  const handleApplyFilters = useCallback(
    async (filters: SearchFilters) => {
      const session = await createSession(filters);
      if (session) {
        router.push(`/chat/${session.id}`);
      }
    },
    [createSession, router]
  );

  const handleSkip = useCallback(async () => {
    const session = await createSession({});
    if (session) {
      router.push(`/chat/${session.id}`);
    }
  }, [createSession, router]);

  return (
    <div className="flex-1 flex items-center justify-center bg-ivory-50 px-6 py-12">
      <div className="w-full max-w-2xl">
        {/* createSession can fail (network, 500). Without this the buttons just
            did nothing and the user had no idea why. */}
        {error && (
          <div className="mb-4 rounded-lg border border-burgundy-700/30 bg-burgundy-100 px-4 py-3">
            <p className="text-[14px] text-burgundy-700">{error}</p>
          </div>
        )}
        <FilterPanel onApply={handleApplyFilters} onSkip={handleSkip} />
      </div>
    </div>
  );
}
