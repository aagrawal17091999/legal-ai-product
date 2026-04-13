"use client";

import { InputHTMLAttributes, forwardRef } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, className = "", ...props }, ref) => {
    return (
      <div className="w-full">
        {label && (
          <label className="block text-[14px] font-medium text-charcoal-600 mb-2">
            {label}
          </label>
        )}
        <input
          ref={ref}
          className={`w-full rounded-lg border bg-ivory-50 px-4 py-3 text-[15px] text-charcoal-900 placeholder:text-charcoal-400 focus:outline-none focus:border-gold-500 focus-visible:[box-shadow:0_0_0_3px_rgba(192,125,43,0.25)] transition-colors ${
            error ? "border-burgundy-700" : "border-ivory-200"
          } ${className}`}
          {...props}
        />
        {error && <p className="mt-2 text-[13px] text-burgundy-700">{error}</p>}
      </div>
    );
  }
);

Input.displayName = "Input";
export default Input;
