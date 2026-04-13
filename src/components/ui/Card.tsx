import { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
}

export default function Card({ children, className = "" }: CardProps) {
  return (
    <div
      className={`bg-ivory-100 rounded-xl border border-ivory-200 ${className}`}
    >
      {children}
    </div>
  );
}
