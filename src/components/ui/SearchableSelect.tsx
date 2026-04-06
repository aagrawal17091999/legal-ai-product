"use client";

import { useState, useRef, useEffect, useCallback } from "react";

interface SearchableSelectProps {
  label?: string;
  placeholder?: string;
  options: string[];
  value: string;
  onChange: (value: string) => void;
}

export default function SearchableSelect({
  label,
  placeholder = "Search...",
  options,
  value,
  onChange,
}: SearchableSelectProps) {
  const [query, setQuery] = useState(value);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Sync query when value changes externally (e.g. reset)
  useEffect(() => {
    setQuery(value);
  }, [value]);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
        // Reset query to current value if user didn't select anything
        setQuery(value);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [value]);

  const filtered = query
    ? options.filter((opt) =>
        opt.toLowerCase().includes(query.toLowerCase())
      )
    : options;

  const visibleOptions = filtered.slice(0, 200);

  const selectOption = useCallback(
    (opt: string) => {
      onChange(opt);
      setQuery(opt);
      setIsOpen(false);
      setHighlightedIndex(-1);
    },
    [onChange]
  );

  const clearValue = useCallback(() => {
    onChange("");
    setQuery("");
    setHighlightedIndex(-1);
    inputRef.current?.focus();
  }, [onChange]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightedIndex >= 0 && listRef.current) {
      const item = listRef.current.children[highlightedIndex] as HTMLElement;
      item?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!isOpen) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        setIsOpen(true);
        setHighlightedIndex(0);
        e.preventDefault();
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightedIndex((prev) =>
          prev < visibleOptions.length - 1 ? prev + 1 : prev
        );
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : 0));
        break;
      case "Enter":
        e.preventDefault();
        if (highlightedIndex >= 0 && visibleOptions[highlightedIndex]) {
          selectOption(visibleOptions[highlightedIndex]);
        }
        break;
      case "Escape":
        setIsOpen(false);
        setQuery(value);
        setHighlightedIndex(-1);
        break;
    }
  }

  return (
    <div ref={containerRef} className="relative w-full">
      {label && (
        <label className="block text-sm font-medium text-slate-700 mb-1">
          {label}
        </label>
      )}
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 pr-8 text-sm text-slate-900 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 bg-white"
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
            setHighlightedIndex(0);
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          role="combobox"
          aria-expanded={isOpen}
          aria-controls="searchable-listbox"
          aria-autocomplete="list"
        />
        {value && (
          <button
            type="button"
            onClick={clearValue}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-sm leading-none"
            aria-label="Clear selection"
          >
            ✕
          </button>
        )}
      </div>
      {isOpen && visibleOptions.length > 0 && (
        <ul
          ref={listRef}
          id="searchable-listbox"
          role="listbox"
          className="absolute z-50 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-y-auto"
        >
          {visibleOptions.map((opt, i) => (
            <li
              key={opt}
              role="option"
              aria-selected={highlightedIndex === i}
              className={`px-3 py-2 text-sm text-slate-900 cursor-pointer ${
                highlightedIndex === i
                  ? "bg-primary-50 text-primary-700"
                  : "hover:bg-slate-50"
              }`}
              onMouseEnter={() => setHighlightedIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault(); // Prevent input blur before click registers
                selectOption(opt);
              }}
            >
              {opt}
            </li>
          ))}
          {filtered.length > 200 && (
            <li className="px-3 py-2 text-xs text-slate-400 text-center">
              {filtered.length - 200} more results — type to narrow
            </li>
          )}
        </ul>
      )}
      {isOpen && query && visibleOptions.length === 0 && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg px-3 py-3 text-sm text-slate-500 text-center">
          No matches found
        </div>
      )}
    </div>
  );
}
