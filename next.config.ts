import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * 개발 서버: 문서는 localhost, 초청 continueUrl·Firebase 리다이렉트는 127.0.0.1인 경우가 많아
   * `/_next/*` 요청 Origin이 달라 경고·향후 차단을 피하기 위해 127.0.0.1을 허용합니다.
   * @see https://nextjs.org/docs/app/api-reference/config/next-config-js/allowedDevOrigins
   */
  allowedDevOrigins: ["127.0.0.1"],
  async rewrites() {
    return [{ source: "/firebase-messaging-sw.js", destination: "/api/fcm-sw" }];
  },
};

export default nextConfig;
