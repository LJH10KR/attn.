/** 키오스크 on/off 후 sessionStorage와 React 상태를 맞출 때 사용 */
export const KIOSK_MODE_CHANGED_EVENT = "attn-kiosk-mode-changed";

export function notifyKioskModeChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(KIOSK_MODE_CHANGED_EVENT));
}
