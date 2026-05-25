import { httpsCallable } from "firebase/functions";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import { kioskModeStorageKey } from "@/lib/academy/kiosk-student-rows";

export async function verifyKioskExitPinAndClear(
  academyId: string,
  pin: string,
): Promise<void> {
  const fn = httpsCallable(getFirebaseFunctions(), "verifyKioskExitPin");
  await fn({ academyId, pin });
  try {
    sessionStorage.removeItem(kioskModeStorageKey(academyId));
  } catch {
    /* ignore */
  }
}

export function clearKioskModeLocal(academyId: string): void {
  try {
    sessionStorage.removeItem(kioskModeStorageKey(academyId));
  } catch {
    /* ignore */
  }
}
