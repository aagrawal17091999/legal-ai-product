"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import FilterPanel from "@/components/chat/FilterPanel";
import { useChatContext } from "../layout";
import type { SearchFilters } from "@/types";

export default function NewChatPage() {
  const { createSession } = useChatContext();
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
    <div className="flex-1 flex items-center justify-center p-8">
      <FilterPanel onApply={handleApplyFilters} onSkip={handleSkip} />
    </div>
  );
}
