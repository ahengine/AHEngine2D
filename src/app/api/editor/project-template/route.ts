import { createRequire } from "node:module";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const projectContract = createRequire(path.join(process.cwd(), "package.json"))(
  "./engine/cli/AH2DProject.js",
) as {
  createProject: (options?: { name?: string; runtime?: "pixijs" | "phaserjs" | "custom" }) => Record<string, unknown>;
};

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: { message: "Request body must be JSON." } }, { status: 400 });
  }
  const rawName = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).name
    : null;
  const name = typeof rawName === "string" ? rawName.trim().replace(/\s+/g, " ").slice(0, 80) : "";
  if (!name) {
    return Response.json({ ok: false, error: { message: "Project name is required." } }, { status: 400 });
  }
  const document = projectContract.createProject({ name, runtime: "pixijs" });
  return Response.json(
    { ok: true, document },
    { headers: { "Cache-Control": "no-store" } },
  );
}
