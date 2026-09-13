import { redirect } from "next/navigation";
import { ProjectDashboard } from "@/components/project-dashboard";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return <ProjectDashboard user={user} />;
}
