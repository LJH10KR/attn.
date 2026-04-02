import type { Metadata } from "next";
import { SignupForm } from "./signup-form";

export const metadata: Metadata = {
  title: "오너 회원가입 — attn.",
  description: "attn. 학원 오너 회원가입",
};

export default function SignupPage() {
  return <SignupForm />;
}
