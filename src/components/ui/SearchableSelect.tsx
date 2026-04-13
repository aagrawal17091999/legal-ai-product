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
        <label className="block text-[14px] font-medium text-charcoal-600 mb-2">
          {label}
        </label>
      )}
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          className="w-full rounded-lg border border-ivory-200 bg-ivory-50 px-4 py-3 pr-10 text-[15px] text-charcoal-900 placeholder:text-charcoal-400 focus:outline-none focus:border-gold-500 focus-visible:[box-shadow:0_0_0_3px_rgba(192,125,43,0.25)] transition-colors"
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
            className="absolute right-3 top-1/2 -translate-y-1/2 text-charcoal-400 hover:text-charcoal-900 text-sm leading-none"
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
          className="absolute z-50 mt-2 w-full bg-ivory-50 border border-ivory-200 rounded-lg shadow-lg max-h-60 overflow-y-auto"
        >
          {visibleOptions.map((opt, i) => (
            <li
              key={opt}
              role="option"
              aria-selected={highlightedIndex === i}
              className={`px-4 py-2.5 text-[14px] cursor-pointer ${
                highlightedIndex === i
                  ? "bg-gold-100 text-charcoal-900"
                  : "text-charcoal-900 hover:bg-ivory-100"
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
            <li className="px-4 py-2 text-[12px] text-charcoal-400 text-center border-t border-ivory-200">
              {filtered.length - 200} more results — type to narrow
            </li>
          )}
        </ul>
      )}
      {isOpen && query && visibleOptions.length === 0 && (
        <div className="absolute z-50 mt-2 w-full bg-ivory-50 border border-ivory-200 rounded-lg shadow-lg px-4 py-3 text-[14px] text-charcoal-600 text-center">
          No matches found
        </div>
      )}
    </div>
  );
}
