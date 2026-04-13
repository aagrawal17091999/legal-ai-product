"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useFilterState } from "@/hooks/useFilterState";
import FilterFormFields from "@/components/filters/FilterFormFields";
import Button from "@/components/ui/Button";
import Spinner from "@/components/ui/Spinner";
import { reportError } from "@/lib/report-error";
import type { FilterOptions, FilterDiagnostic, JudgmentSearchResult, JudgmentSearchResponse } from "@/types";

export default function JudgmentsPage() {
  const { getToken } = useAuth();
  const filterState = useFilterState();

  const [options, setOptions] = useState<FilterOptions | null>(null);
  const [results, setResults] = useState<JudgmentSearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [diagnostics, setDiagnostics] = useState<FilterDiagnostic[] | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);

  // Load filter options
  useEffect(() => {
    fetch("/api/filters/options")
      .then((res) => res.json())
      .then(setOptions)
      .catch((err) => {
        reportError("Failed to load filter options", { component: "JudgmentsPage" }, err);
      });
  }, []);

  const authHeaders = useCallback(async () => {
    const token = await getToken();
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
  }, [getToken]);

  // Debounced live count preview
  useEffect(() => {
    if (!filterState.hasAnyFilter()) {
      setPreviewCount(null);
      return;
    }

    const timer = setTimeout(async () => {
      // Abort any in-flight preview request
      previewAbortRef.current?.abort();
      const controller = new AbortController();
      previewAbortRef.current = controller;

      try {
        const filters = filterState.buildFiltersObject();
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(filters)) {
          if (value !== undefined && value !== "") {
            params.set(key, String(value));
          }
        }
        params.set("countOnly", "true");

        const token = await getToken();
        const res = await fetch(`/api/judgments/search?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });

        if (res.ok) {
          const data = await res.json();
          setPreviewCount(data.total);
        }
      } catch {
        // Ignore abort errors
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [
    filterState.court, filterState.yearFrom, filterState.yearTo,
    filterState.citation, filterState.extractedPetitioner, filterState.extractedRespondent,
    filterState.caseCategory, filterState.caseNumber, filterState.judgeName,
    filterState.actCited, filterState.keyword, getToken, filterState,
  ]);

  const search = useCallback(async (searchPage: number = 1) => {
    if (!filterState.hasAnyFilter()) {
      setError("Please select at least one filter to search.");
      return;
    }

    setError(null);
    setIsSearching(true);
    setHasSearched(true);

    try {
      const filters = filterState.buildFiltersObject();
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && value !== "") {
          params.set(key, String(value));
        }
      }
      params.set("page", String(searchPage));
      params.set("limit", String(limit));

      const headers = await authHeaders();
      const res = await fetch(`/api/judgments/search?${params}`, { headers });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Search failed");
        setResults([]);
        setTotal(0);
        return;
      }

      const data: JudgmentSearchResponse = await res.json();
      setResults(data.results);
      setTotal(data.total);
      setPage(data.page);
      setDiagnostics(data.diagnostics || null);
    } catch (err) {
      setError("Failed to search. Please try again.");
      reportError("Judgment search failed", { component: "JudgmentsPage" }, err);
    } finally {
      setIsSearching(false);
    }
  }, [filterState, limit, authHeaders]);

  const handleDownload = async (result: JudgmentSearchResult) => {
    const downloadKey = `${result.source_table}_${result.id}`;
    setDownloadingId(downloadKey);

    try {
      const headers = await authHeaders();
      const res = await fetch(
        `/api/judgments/download?source=${result.source_table}&id=${result.id}`,
        { headers }
      );

      if (!res.ok) {
        const data = await res.json();
        alert(data.error || "PDF not available");
        return;
      }

      const { url } = await res.json();
      window.open(url, "_blank");
    } catch (err) {
      alert("Failed to download PDF. Please try again.");
      reportError("PDF download failed", { component: "JudgmentsPage", caseId: result.id }, err);
    } finally {
      setDownloadingId(null);
    }
  };

  const totalPages = Math.ceil(total / limit);

  const handleClear = () => {
    filterState.resetFilters();
    setResults([]);
    setTotal(0);
    setHasSearched(false);
    setError(null);
    setPreviewCount(null);
    setDiagnostics(null);
  };

  return (
    <div className="flex-1 overflow-y-auto bg-ivory-50">
      <div className="max-w-6xl mx-auto px-6 py-12 sm:py-16">
        {/* Header */}
        <div className="mb-10">
          <span className="overline">Library</span>
          <h1 className="mt-5 font-serif text-4xl sm:text-[44px] leading-tight tracking-tight text-charcoal-900">
            Judgment Library.
          </h1>
          <p className="mt-4 max-w-2xl text-[15px] text-charcoal-600 leading-relaxed">
            Browse and search the full database of Supreme Court and High Court
            judgments indexed by NyayaSearch. Filter by court, year, judge, act,
            or party name.
          </p>
        </div>

        {/* Filters */}
        <div className="bg-ivory-100 border border-ivory-200 rounded-xl p-8 mb-6">
          <FilterFormFields options={options} {...filterState} />

          <div className="flex items-center gap-3 pt-6">
            <Button
              variant="primary"
              onClick={() => search(1)}
              disabled={isSearching}
              size="lg"
            >
              {isSearching
                ? "Searching…"
                : previewCount !== null
                  ? `Search Judgments (${previewCount} result${previewCount !== 1 ? "s" : ""}) →`
                  : "Search Judgments →"}
            </Button>
            <Button variant="ghost" size="lg" onClick={handleClear}>
              Clear Filters
            </Button>
          </div>

          {error && (
            <p className="mt-4 text-[14px] text-burgundy-700">{error}</p>
          )}
        </div>

        {/* Results */}
        {isSearching && (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        )}

        {!isSearching && hasSearched && results.length === 0 && (
          <div className="bg-ivory-100 rounded-xl border border-ivory-200 p-8">
            <h3 className="font-serif text-2xl text-charcoal-900">
              No judgments match your filters.
            </h3>
            {diagnostics && diagnostics.length > 0 ? (
              <div className="mt-5">
                <p className="text-[14px] text-charcoal-600 mb-4 leading-relaxed">
                  Each filter works individually, but together they have no overlap. Here is how each filter performs on its own:
                </p>
                <div className="space-y-2">
                  {diagnostics.map((d) => (
                    <div key={d.filterName} className="flex items-center gap-3 text-[14px]">
                      <span className={`inline-flex items-center justify-center w-12 text-right font-mono font-medium ${d.count === 0 ? "text-burgundy-700" : "text-teal-600"}`}>
                        {d.count}
                      </span>
                      <span className="text-charcoal-400">—</span>
                      <span className="font-medium text-charcoal-900">{d.filterName}:</span>
                      <span className="text-charcoal-600">&ldquo;{d.filterValue}&rdquo;</span>
                    </div>
                  ))}
                </div>
                <p className="mt-5 text-[14px] text-charcoal-600">
                  Try removing a filter to broaden your search. If you believe a judgment is missing from our database, let us know at{" "}
                  <a href="mailto:hello@nyayasearch.com" className="text-gold-600 hover:text-gold-700">
                    hello@nyayasearch.com
                  </a>.
                </p>
              </div>
            ) : (
              <p className="mt-3 text-[14px] text-charcoal-600">
                Try adjusting your search criteria.
              </p>
            )}
          </div>
        )}

        {!isSearching && results.length > 0 && (
          <>
            <div className="mb-4 text-[13px] text-charcoal-600 uppercase tracking-wider">
              Showing {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total} judgments
            </div>

            {/* Desktop table */}
            <div className="hidden md:block bg-ivory-50 rounded-xl border border-ivory-200 overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="bg-ivory-100 border-b border-ivory-200">
                    <th className="text-left px-6 py-4 text-[11px] font-medium text-charcoal-400 uppercase tracking-wider">Case title</th>
                    <th className="text-left px-6 py-4 text-[11px] font-medium text-charcoal-400 uppercase tracking-wider">Court</th>
                    <th className="text-left px-6 py-4 text-[11px] font-medium text-charcoal-400 uppercase tracking-wider">Year</th>
                    <th className="text-left px-6 py-4 text-[11px] font-medium text-charcoal-400 uppercase tracking-wider">Citation</th>
                    <th className="text-right px-6 py-4 text-[11px] font-medium text-charcoal-400 uppercase tracking-wider">PDF</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => {
                    const downloadKey = `${r.source_table}_${r.id}`;
                    return (
                      <tr key={downloadKey} className="border-b border-ivory-200 last:border-b-0 hover:bg-ivory-100 transition-colors">
                        <td className="px-6 py-4">
                          <div className="text-[14px] font-medium text-charcoal-900 line-clamp-2">{r.title}</div>
                          {(r.petitioner || r.respondent) && (
                            <div className="text-[13px] text-charcoal-600 mt-1 italic">
                              {r.petitioner && r.respondent
                                ? `${r.petitioner} v. ${r.respondent}`
                                : r.petitioner || r.respondent}
                            </div>
                          )}
                        </td>
                        <td className="px-6 py-4 text-[14px] text-charcoal-600">{r.court}</td>
                        <td className="px-6 py-4 text-[14px] text-charcoal-600 font-mono">{r.year || "—"}</td>
                        <td className="px-6 py-4 text-[14px] text-charcoal-600 font-mono">{r.citation || "—"}</td>
                        <td className="px-6 py-4 text-right">
                          {r.has_pdf ? (
                            <button
                              onClick={() => handleDownload(r)}
                              disabled={downloadingId === downloadKey}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium text-gold-700 bg-gold-100 rounded-lg hover:bg-gold-100/80 transition-colors disabled:opacity-50"
                            >
                              {downloadingId === downloadKey ? (
                                <Spinner size="sm" />
                              ) : (
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                </svg>
                              )}
                              Download
                            </button>
                          ) : (
                            <span className="text-[13px] text-charcoal-400">Not available</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden space-y-3">
              {results.map((r) => {
                const downloadKey = `${r.source_table}_${r.id}`;
                return (
                  <div key={downloadKey} className="bg-ivory-50 rounded-xl border border-ivory-200 p-5">
                    <div className="text-[14px] font-medium text-charcoal-900 line-clamp-2">{r.title}</div>
                    {(r.petitioner || r.respondent) && (
                      <div className="text-[13px] text-charcoal-600 mt-1 italic">
                        {r.petitioner && r.respondent
                          ? `${r.petitioner} v. ${r.respondent}`
                          : r.petitioner || r.respondent}
                      </div>
                    )}
                    <div className="flex items-center gap-3 mt-3 text-[13px] text-charcoal-600">
                      <span>{r.court}</span>
                      {r.year && <span className="font-mono">{r.year}</span>}
                      {r.citation && <span className="font-mono">{r.citation}</span>}
                    </div>
                    <div className="mt-4">
                      {r.has_pdf ? (
                        <button
                          onClick={() => handleDownload(r)}
                          disabled={downloadingId === downloadKey}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium text-gold-700 bg-gold-100 rounded-lg hover:bg-gold-100/80 transition-colors disabled:opacity-50"
                        >
                          {downloadingId === downloadKey ? (
                            <Spinner size="sm" />
                          ) : (
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                          )}
                          Download PDF
                        </button>
                      ) : (
                        <span className="text-[13px] text-charcoal-400">PDF not available</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-4 mt-8">
                <Button
                  variant="ghost"
                  onClick={() => search(page - 1)}
                  disabled={page <= 1 || isSearching}
                >
                  ← Previous
                </Button>
                <span className="text-[13px] text-charcoal-600 uppercase tracking-wider">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="ghost"
                  onClick={() => search(page + 1)}
                  disabled={page >= totalPages || isSearching}
                >
                  Next →
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
