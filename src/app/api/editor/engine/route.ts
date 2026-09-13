import { readFile } from "node:fs/promises";
import path from "node:path";
import { authErrorResponse, requireRequestAuth } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireRequestAuth(request);
    const [dataModelSource, engineSource] = await Promise.all([
      readFile(path.join(process.cwd(), "engine", "AH2DDataModel.js"), "utf8"),
      readFile(path.join(process.cwd(), "engine", "AH2DEngine.js"), "utf8"),
    ]);
    const source = `${dataModelSource}\n;\n${engineSource}`;

    return new Response(source, {
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
