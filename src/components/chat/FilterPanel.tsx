"use client";

import { useState, useEffect } from "react";
import Button from "@/components/ui/Button";
import FilterFormFields from "@/components/filters/FilterFormFields";
import { useFilterState } from "@/hooks/useFilterState";
import { reportError } from "@/lib/report-error";
import type { SearchFilters, FilterOptions } from "@/types";

interface FilterPanelProps {
  onApply: (filters: SearchFilters) => void;
  onSkip: () => void;
}

export default function FilterPanel({ onApply, onSkip }: FilterPanelProps) {
  const [options, setOptions] = useState<FilterOptions | null>(null);
  const filterState = useFilterState();

  useEffect(() => {
    fetch("/api/filters/options")
      .then((res) => res.json())
      .then(setOptions)
      .catch((err) => {
        reportError("Failed to load filter options", { component: "FilterPanel" }, err);
      });
  }, []);

  const handleApply = () => {
    onApply(filterState.buildFiltersObject());
  };

  return (
    <div className="max-w-3xl mx-auto">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold text-slate-900">Start a New Chat</h2>
        <p className="mt-2 text-slate-600">
          Set filters to narrow your search, or skip to search all case law.
        </p>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <FilterFormFields options={options} {...filterState} />

        <div className="flex items-center gap-3 pt-4">
          <Button onClick={handleApply} className="flex-1">
            Apply Filters & Start Chat
          </Button>
          <Button variant="ghost" onClick={onSkip}>
            Skip Filters
          </Button>
        </div>
      </div>
    </div>
  );
}
