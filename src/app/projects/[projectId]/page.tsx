import { redirect } from "next/navigation";
import { CollaborativeWorkspace } from "@/components/collaborative-workspace";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function ProjectWorkspacePage({
  params,
}: Readonly<{ params: Promise<{ projectId: string }> }>) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { projectId } = await params;

  return <CollaborativeWorkspace projectId={projectId} user={user} />;
}
