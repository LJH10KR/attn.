import { collection, getDocs } from "firebase/firestore";
import type { KioskStudentRow } from "@/components/academy/academy-kiosk-panel";
import { getFirebaseDb } from "@/lib/firebase/client-app";

function phoneLast4(phone: unknown): string | null {
  if (typeof phone !== "string") return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

export async function loadKioskStudentRows(academyId: string): Promise<KioskStudentRow[]> {
  const db = getFirebaseDb();
  const [studentsSnap, parentsSnap] = await Promise.all([
    getDocs(collection(db, "academies", academyId, "students")),
    getDocs(collection(db, "academies", academyId, "parents")),
  ]);

  const parentNameByUid = new Map<string, string>();
  for (const d of parentsSnap.docs) {
    const authUid = d.get("authUid");
    const uid = typeof authUid === "string" && authUid ? authUid : d.id;
    const name = d.get("displayName");
    if (typeof name === "string" && name) {
      parentNameByUid.set(uid, name);
    }
  }

  const rows: KioskStudentRow[] = [];
  for (const d of studentsSnap.docs) {
    const name = d.get("name");
    if (typeof name !== "string" || !name.trim()) continue;
    const parentUserId = d.get("parentUserId");
    const parentName =
      typeof parentUserId === "string"
        ? parentNameByUid.get(parentUserId) ?? ""
        : "";
    rows.push({
      studentId: d.id,
      name: name.trim(),
      phoneLast4: phoneLast4(d.get("phone")),
      parentName,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  return rows;
}

export function kioskModeStorageKey(academyId: string): string {
  return `attn_kiosk_mode_${academyId}`;
}
