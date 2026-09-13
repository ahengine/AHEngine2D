import { CollaborativeWorkspace } from "@/components/collaborative-workspace";

export const dynamic = "force-dynamic";

export default async function ProjectWorkspacePage({
  params,
}: Readonly<{ params: Promise<{ projectId: string }> }>) {
  const { projectId } = await params;

  return <CollaborativeWorkspace projectId={projectId} />;
}
