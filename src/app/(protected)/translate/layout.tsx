import { redirect } from "next/navigation";
import { TRANSLATION_ENABLED } from "@/lib/translate/enabled";

export default function TranslateLayout({ children }: { children: React.ReactNode }) {
  if (!TRANSLATION_ENABLED) redirect("/chat");
  return children;
}
