/** 앱 주소(`APP_ORIGIN`, 끝 슬래시 제외) — 직원 초대 링크 등 학원에 보여 줄 링크용 */
export function getAppOrigin(): string {
  const o = process.env.APP_ORIGIN?.trim();
  return o && o.length > 0 ? o.replace(/\/+$/, "") : "http://127.0.0.1:3000";
}
