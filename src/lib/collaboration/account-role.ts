import type { Role as AccountRole } from "@/types/auth";
import type { ProjectRole } from "./types";

export const ACCOUNT_PROJECT_ROLE_CAP: Readonly<Record<AccountRole, readonly ProjectRole[]>> = {
  OWNER: ["admin", "editor", "commenter", "viewer"],
  ADMIN: ["admin", "editor", "commenter", "viewer"],
  EDITOR: ["editor", "commenter", "viewer"],
  COMMENTER: ["commenter", "viewer"],
  VIEWER: ["viewer"],
};

export function accountAllowsProjectRole(accountRole: AccountRole, projectRole: unknown): projectRole is ProjectRole {
  return typeof projectRole === "string" && ACCOUNT_PROJECT_ROLE_CAP[accountRole].includes(projectRole as ProjectRole);
}
