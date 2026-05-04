import { NextRequest, NextResponse } from "next/server";
import { FIREBASE_FUNCTIONS_REGION } from "@/lib/firebase/config";

function resolveProjectId(): string {
  return (
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim() ||
    process.env.FIREBASE_PROJECT_ID?.trim() ||
    ""
  );
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ code: string }> },
) {
  const { code } = await ctx.params;
  const normalized = code.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!normalized) {
    return NextResponse.json({ error: "Invalid link code." }, { status: 400 });
  }

  const projectId = resolveProjectId();
  if (!projectId) {
    return NextResponse.json({ error: "Project ID is not configured." }, { status: 500 });
  }

  const fnUrl = `https://${FIREBASE_FUNCTIONS_REGION}-${projectId}.cloudfunctions.net/openShortAuthLink/${normalized}`;
  return NextResponse.redirect(fnUrl, 302);
}
