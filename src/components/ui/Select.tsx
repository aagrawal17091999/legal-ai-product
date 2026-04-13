"use client";

import { SelectHTMLAttributes, forwardRef } from "react";

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: { value: string; label: string }[];
}

const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, options, className = "", ...props }, ref) => {
    return (
      <div className="w-full">
        {label && (
          <label className="block text-[14px] font-medium text-charcoal-600 mb-2">
            {label}
          </label>
        )}
        <select
          ref={ref}
          className={`w-full rounded-lg border border-ivory-200 bg-ivory-50 px-4 py-3 text-[15px] text-charcoal-900 focus:outline-none focus:border-gold-500 focus-visible:[box-shadow:0_0_0_3px_rgba(192,125,43,0.25)] transition-colors ${className}`}
          {...props}
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    );
  }
);

Select.displayName = "Select";
export default Select;
