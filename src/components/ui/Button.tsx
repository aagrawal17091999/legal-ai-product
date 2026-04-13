"use client";

import { ButtonHTMLAttributes, forwardRef } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "primaryOnDark" | "secondary" | "outline" | "ghost" | "destructive";
  size?: "sm" | "md" | "lg";
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", className = "", children, ...props }, ref) => {
    const base =
      "inline-flex items-center justify-center gap-2 font-medium rounded-lg transition-colors focus:outline-none focus-visible:[box-shadow:0_0_0_3px_rgba(192,125,43,0.4)] disabled:opacity-50 disabled:cursor-not-allowed";

    const variants = {
      // Primary on light backgrounds: deep navy button, ivory text.
      primary:
        "bg-navy-950 text-ivory-50 hover:bg-navy-800",
      // Primary on dark backgrounds: gold button, navy text.
      primaryOnDark:
        "bg-gold-500 text-navy-950 hover:bg-gold-400",
      // Neutral secondary on light backgrounds.
      secondary:
        "bg-ivory-100 text-charcoal-900 hover:bg-ivory-200",
      // Outline on light backgrounds.
      outline:
        "border border-ivory-200 bg-transparent text-charcoal-900 hover:bg-ivory-100",
      // Text-only / ghost.
      ghost:
        "text-charcoal-600 hover:text-charcoal-900 hover:bg-ivory-100",
      // Destructive — burgundy outline.
      destructive:
        "border border-burgundy-700 bg-transparent text-burgundy-700 hover:bg-burgundy-100",
    };

    const sizes = {
      sm: "text-sm px-3 py-1.5",
      md: "text-[15px] px-5 py-2.5",
      lg: "text-base px-6 py-3",
    };

    return (
      <button
        ref={ref}
        className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
        {...props}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";
export default Button;
