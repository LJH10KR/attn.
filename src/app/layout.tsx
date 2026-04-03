import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import { Noto_Sans_KR } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const notoSansKr = Noto_Sans_KR({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-noto-kr",
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "attn.",
  description: "학부모를 위한 출석·결석 알림 서비스",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const nonce = (await headers()).get("x-nonce") ?? "";

  // CSP nonce: 미들웨어·RSC 스트리밍 타이밍으로 서버 HTML과 hydration 시점 속성이 어긋날 수 있음 → html에만 suppressHydrationWarning.
  return (
    <html lang="ko" nonce={nonce || undefined} suppressHydrationWarning>
      <body
        className={`${notoSansKr.variable} ${geistMono.variable} font-sans antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
