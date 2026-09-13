import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";

export default async function HomePage() {
  redirect((await getCurrentUser()) ? "/projects" : "/login");
}
