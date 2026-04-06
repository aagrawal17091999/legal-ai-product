"use client";

import SearchableSelect from "@/components/ui/SearchableSelect";
import Input from "@/components/ui/Input";
import type { FilterOptions } from "@/types";

interface FilterFormFieldsProps {
  options: FilterOptions | null;
  court: string;
  setCourt: (v: string) => void;
  caseCategory: string;
  setCaseCategory: (v: string) => void;
  citation: string;
  setCitation: (v: string) => void;
  caseNumber: string;
  setCaseNumber: (v: string) => void;
  judgeName: string;
  setJudgeName: (v: string) => void;
  extractedPetitioner: string;
  setExtractedPetitioner: (v: string) => void;
  extractedRespondent: string;
  setExtractedRespondent: (v: string) => void;
  actCited: string;
  setActCited: (v: string) => void;
  keyword: string;
  setKeyword: (v: string) => void;
  yearFrom: string;
  setYearFrom: (v: string) => void;
  yearTo: string;
  setYearTo: (v: string) => void;
}

export default function FilterFormFields({
  options,
  court, setCourt,
  caseCategory, setCaseCategory,
  citation, setCitation,
  caseNumber, setCaseNumber,
  judgeName, setJudgeName,
  extractedPetitioner, setExtractedPetitioner,
  extractedRespondent, setExtractedRespondent,
  actCited, setActCited,
  keyword, setKeyword,
  yearFrom, setYearFrom,
  yearTo, setYearTo,
}: FilterFormFieldsProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <SearchableSelect
        label="Court"
        placeholder="All Courts"
        options={options?.courts || []}
        value={court}
        onChange={setCourt}
      />

      <SearchableSelect
        label="Case Category"
        placeholder="Search categories..."
        options={options?.caseCategories || []}
        value={caseCategory}
        onChange={setCaseCategory}
      />

      <SearchableSelect
        label="Citation"
        placeholder="Search citations..."
        options={options?.citations || []}
        value={citation}
        onChange={setCitation}
      />

      <SearchableSelect
        label="Case Number"
        placeholder="Search case numbers..."
        options={options?.caseNumbers || []}
        value={caseNumber}
        onChange={setCaseNumber}
      />

      <SearchableSelect
        label="Judge Name"
        placeholder="Search judge names..."
        options={options?.judgeNames || []}
        value={judgeName}
        onChange={setJudgeName}
      />

      <SearchableSelect
        label="Petitioner"
        placeholder="Search petitioners..."
        options={options?.extractedPetitioners || []}
        value={extractedPetitioner}
        onChange={setExtractedPetitioner}
      />

      <SearchableSelect
        label="Respondent"
        placeholder="Search respondents..."
        options={options?.extractedRespondents || []}
        value={extractedRespondent}
        onChange={setExtractedRespondent}
      />

      <SearchableSelect
        label="Acts Cited"
        placeholder="Search acts..."
        options={options?.actsCited || []}
        value={actCited}
        onChange={setActCited}
      />

      <SearchableSelect
        label="Keywords"
        placeholder="Search keywords..."
        options={options?.keywords || []}
        value={keyword}
        onChange={setKeyword}
      />

      <Input
        label="Year From"
        type="number"
        placeholder={String(options?.years.min || 1950)}
        value={yearFrom}
        onChange={(e) => setYearFrom(e.target.value)}
      />
      <Input
        label="Year To"
        type="number"
        placeholder={String(options?.years.max || new Date().getFullYear())}
        value={yearTo}
        onChange={(e) => setYearTo(e.target.value)}
      />
    </div>
  );
}
