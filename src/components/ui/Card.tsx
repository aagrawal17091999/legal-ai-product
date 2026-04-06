import { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
}

export default function Card({ children, className = "" }: CardProps) {
  return (
    <div
      className={`bg-white rounded-lg border border-slate-200 shadow-sm ${className}`}
    >
      {children}
    </div>
  );
}
