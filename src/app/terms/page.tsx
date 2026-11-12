import type { Metadata } from "next";
import { LegalDocumentPage } from "@/components/legal/legal-document-page";

export const metadata: Metadata = { title: "이용약관 · attn." };

export default function TermsPage() {
  return <LegalDocumentPage kind="terms" />;
}
