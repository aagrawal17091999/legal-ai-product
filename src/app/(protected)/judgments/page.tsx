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
    <div className="flex-1 overflow-y-auto bg-slate-50">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900">Judgment Library</h1>
          <p className="mt-2 text-slate-600">
            Search and download judgment PDFs using filters.
          </p>
        </div>

        {/* Filters */}
        <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
          <FilterFormFields options={options} {...filterState} />

          <div className="flex items-center gap-3 pt-4">
            <Button onClick={() => search(1)} disabled={isSearching}>
              {isSearching
                ? "Searching..."
                : previewCount !== null
                  ? `Search Judgments (${previewCount} result${previewCount !== 1 ? "s" : ""})`
                  : "Search Judgments"}
            </Button>
            <Button variant="ghost" onClick={handleClear}>
              Clear Filters
            </Button>
          </div>

          {error && (
            <p className="mt-3 text-sm text-red-600">{error}</p>
          )}
        </div>

        {/* Results */}
        {isSearching && (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        )}

        {!isSearching && hasSearched && results.length === 0 && (
          <div className="bg-white rounded-xl border border-slate-200 p-6">
            <p className="text-slate-700 font-medium">No judgments match all selected filters combined.</p>
            {diagnostics && diagnostics.length > 0 ? (
              <div className="mt-4">
                <p className="text-sm text-slate-500 mb-3">
                  Each filter works individually, but together they have no overlap. Here is how each filter performs on its own:
                </p>
                <div className="space-y-2">
                  {diagnostics.map((d) => (
                    <div key={d.filterName} className="flex items-center gap-2 text-sm">
                      <span className={`inline-flex items-center justify-center w-12 text-right font-mono font-medium ${d.count === 0 ? "text-red-600" : "text-green-600"}`}>
                        {d.count}
                      </span>
                      <span className="text-slate-400">-</span>
                      <span className="font-medium text-slate-700">{d.filterName}:</span>
                      <span className="text-slate-600">&ldquo;{d.filterValue}&rdquo;</span>
                    </div>
                  ))}
                </div>
                <p className="mt-4 text-sm text-slate-500">
                  Try removing a filter to broaden your search.
                </p>
              </div>
            ) : (
              <p className="mt-2 text-sm text-slate-500">
                Try adjusting your search criteria.
              </p>
            )}
          </div>
        )}

        {!isSearching && results.length > 0 && (
          <>
            <div className="mb-4 text-sm text-slate-600">
              Showing {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total} judgments
            </div>

            {/* Desktop table */}
            <div className="hidden md:block bg-white rounded-xl border border-slate-200 overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase">Title</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase">Court</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase">Year</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase">Citation</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-slate-500 uppercase">PDF</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => {
                    const downloadKey = `${r.source_table}_${r.id}`;
                    return (
                      <tr key={downloadKey} className="border-b border-slate-100 hover:bg-slate-50">
                        <td className="px-4 py-3">
                          <div className="text-sm font-medium text-slate-900 line-clamp-2">{r.title}</div>
                          {(r.petitioner || r.respondent) && (
                            <div className="text-xs text-slate-500 mt-0.5">
                              {r.petitioner && r.respondent
                                ? `${r.petitioner} v. ${r.respondent}`
                                : r.petitioner || r.respondent}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-600">{r.court}</td>
                        <td className="px-4 py-3 text-sm text-slate-600">{r.year || "—"}</td>
                        <td className="px-4 py-3 text-sm text-slate-600">{r.citation || "—"}</td>
                        <td className="px-4 py-3 text-right">
                          {r.has_pdf ? (
                            <button
                              onClick={() => handleDownload(r)}
                              disabled={downloadingId === downloadKey}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary-700 bg-primary-50 rounded-lg hover:bg-primary-100 transition-colors disabled:opacity-50"
                            >
                              {downloadingId === downloadKey ? (
                                <Spinner />
                              ) : (
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                </svg>
                              )}
                              Download
                            </button>
                          ) : (
                            <span className="text-xs text-slate-400">Not available</span>
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
                  <div key={downloadKey} className="bg-white rounded-xl border border-slate-200 p-4">
                    <div className="text-sm font-medium text-slate-900 line-clamp-2">{r.title}</div>
                    {(r.petitioner || r.respondent) && (
                      <div className="text-xs text-slate-500 mt-0.5">
                        {r.petitioner && r.respondent
                          ? `${r.petitioner} v. ${r.respondent}`
                          : r.petitioner || r.respondent}
                      </div>
                    )}
                    <div className="flex items-center gap-3 mt-2 text-xs text-slate-500">
                      <span>{r.court}</span>
                      {r.year && <span>{r.year}</span>}
                      {r.citation && <span>{r.citation}</span>}
                    </div>
                    <div className="mt-3">
                      {r.has_pdf ? (
                        <button
                          onClick={() => handleDownload(r)}
                          disabled={downloadingId === downloadKey}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary-700 bg-primary-50 rounded-lg hover:bg-primary-100 transition-colors disabled:opacity-50"
                        >
                          {downloadingId === downloadKey ? (
                            <Spinner />
                          ) : (
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                          )}
                          Download PDF
                        </button>
                      ) : (
                        <span className="text-xs text-slate-400">PDF not available</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-4 mt-6">
                <Button
                  variant="ghost"
                  onClick={() => search(page - 1)}
                  disabled={page <= 1 || isSearching}
                >
                  Previous
                </Button>
                <span className="text-sm text-slate-600">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="ghost"
                  onClick={() => search(page + 1)}
                  disabled={page >= totalPages || isSearching}
                >
                  Next
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
