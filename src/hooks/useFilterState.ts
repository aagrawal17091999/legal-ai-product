"use client";

import { useState } from "react";
import type { SearchFilters } from "@/types";

export function useFilterState() {
  const [court, setCourt] = useState("");
  const [yearFrom, setYearFrom] = useState("");
  const [yearTo, setYearTo] = useState("");
  const [citation, setCitation] = useState("");
  const [extractedPetitioner, setExtractedPetitioner] = useState("");
  const [extractedRespondent, setExtractedRespondent] = useState("");
  const [caseCategory, setCaseCategory] = useState("");
  const [caseNumber, setCaseNumber] = useState("");
  const [judgeName, setJudgeName] = useState("");
  const [actCited, setActCited] = useState("");
  const [keyword, setKeyword] = useState("");

  function buildFiltersObject(): SearchFilters {
    const filters: SearchFilters = {};
    if (court) filters.court = court;
    if (yearFrom) filters.yearFrom = parseInt(yearFrom);
    if (yearTo) filters.yearTo = parseInt(yearTo);
    if (citation) filters.citation = citation;
    if (extractedPetitioner) filters.extractedPetitioner = extractedPetitioner;
    if (extractedRespondent) filters.extractedRespondent = extractedRespondent;
    if (caseCategory) filters.caseCategory = caseCategory;
    if (caseNumber) filters.caseNumber = caseNumber;
    if (judgeName) filters.judgeName = judgeName;
    if (actCited) filters.actCited = actCited;
    if (keyword) filters.keyword = keyword;
    return filters;
  }

  function resetFilters() {
    setCourt("");
    setYearFrom("");
    setYearTo("");
    setCitation("");
    setExtractedPetitioner("");
    setExtractedRespondent("");
    setCaseCategory("");
    setCaseNumber("");
    setJudgeName("");
    setActCited("");
    setKeyword("");
  }

  function hasAnyFilter(): boolean {
    return !!(court || yearFrom || yearTo || citation || extractedPetitioner ||
      extractedRespondent || caseCategory || caseNumber || judgeName || actCited || keyword);
  }

  return {
    court, setCourt,
    yearFrom, setYearFrom,
    yearTo, setYearTo,
    citation, setCitation,
    extractedPetitioner, setExtractedPetitioner,
    extractedRespondent, setExtractedRespondent,
    caseCategory, setCaseCategory,
    caseNumber, setCaseNumber,
    judgeName, setJudgeName,
    actCited, setActCited,
    keyword, setKeyword,
    buildFiltersObject,
    resetFilters,
    hasAnyFilter,
  };
}
