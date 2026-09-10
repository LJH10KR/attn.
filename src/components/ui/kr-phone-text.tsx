import { formatKrPhoneDisplayOrDash } from "@/lib/phone/kr-phone";

export function KrPhoneText({
  phone,
  className,
}: {
  phone?: string | null;
  className?: string;
}) {
  return <span className={className}>{formatKrPhoneDisplayOrDash(phone)}</span>;
}
