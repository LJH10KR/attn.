import type { Metadata } from "next";
import { LegalDocumentPage } from "@/components/legal/legal-document-page";

export const metadata: Metadata = { title: "개인정보 처리방침 · attn." };

export default function PrivacyPage() {
  return <LegalDocumentPage kind="privacy" />;
}
