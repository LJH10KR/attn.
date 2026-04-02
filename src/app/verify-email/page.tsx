import type { Metadata } from "next";
import { VerifyEmailForm } from "./verify-email-form";

export const metadata: Metadata = {
  title: "이메일 인증 — attn.",
  description: "이메일 인증을 완료해 주세요.",
};

export default function VerifyEmailPage() {
  return <VerifyEmailForm />;
}
