import { redirect } from "next/navigation";

export default async function ProjectWorkspacePage({
  params,
}: Readonly<{ params: Promise<{ projectId: string }> }>) {
  await params;
  redirect("/");
}
