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

const FILTER_OPTIONS_CACHE_KEY = "nyaya:filter-options";

function readCachedFilterOptions(): FilterOptions | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(FILTER_OPTIONS_CACHE_KEY);
    return raw ? (JSON.parse(raw) as FilterOptions) : null;
  } catch {
    return null;
  }
}

export default function FilterPanel({ onApply, onSkip }: FilterPanelProps) {
  const [options, setOptions] = useState<FilterOptions | null>(
    () => readCachedFilterOptions()
  );
  const filterState = useFilterState();

  useEffect(() => {
    fetch("/api/filters/options")
      .then((res) => res.json())
      .then((data: FilterOptions) => {
        setOptions(data);
        try {
          window.localStorage.setItem(
            FILTER_OPTIONS_CACHE_KEY,
            JSON.stringify(data)
          );
        } catch {
          /* ignore storage errors */
        }
      })
      .catch((err) => {
        reportError("Failed to load filter options", { component: "FilterPanel" }, err);
      });
  }, []);

  const handleApply = () => {
    onApply(filterState.buildFiltersObject());
  };

  return (
    <div className="max-w-3xl mx-auto w-full">
      <div className="mb-10">
        <span className="overline">Start a new research session</span>
        <h2 className="mt-5 font-serif text-4xl sm:text-[44px] leading-tight tracking-tight text-charcoal-900">
          Refine your search.
        </h2>
        <p className="mt-4 text-[15px] text-charcoal-600 max-w-xl leading-relaxed">
          Narrow results by jurisdiction, authority, or subject matter. All
          filters are optional — skip to search all indexed case law.
        </p>
      </div>

      <div className="bg-ivory-100 border border-ivory-200 rounded-xl p-8 space-y-6">
        <FilterFormFields options={options} {...filterState} />

        <div className="flex items-center gap-3 pt-2">
          <Button onClick={handleApply} className="flex-1" size="lg">
            Apply Filters & Start →
          </Button>
          <Button variant="ghost" size="lg" onClick={onSkip}>
            Skip Filters
          </Button>
        </div>
      </div>
    </div>
  );
}
