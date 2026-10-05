import { apiErrorMessage } from "./agents-api";
import type { SkillFile } from "../../../packages/core/src/skills/config";

export type { SkillFile };

export interface SkillSecret {
  id: string;
  name: string;
  allowedHosts: string[];
}

export interface SkillListItem {
  id: string;
  name: string;
  description: string;
  fileCount: number;
  secrets: SkillSecret[];
  automations: Array<{ id: string; name: string }>;
  updatedAt: string;
}

export interface SkillDetail extends SkillListItem {
  instructions: string;
  files: SkillFile[];
}

export interface SkillInput {
  name: string;
  description: string;
  instructions: string;
  files: SkillFile[];
  secretIds: string[];
}

async function skillJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return body as T;
}

export async function fetchSkills(): Promise<SkillListItem[]> {
  return (await skillJson<{ skills: SkillListItem[] }>("/api/skills")).skills;
}

export async function fetchSkill(skillId: string): Promise<SkillDetail> {
  return (await skillJson<{ skill: SkillDetail }>(`/api/skills/${skillId}`)).skill;
}

// Creates the skill when `skillId` is undefined. Returns the skill's ID.
export async function saveSkill(skillId: string | undefined, input: SkillInput): Promise<string> {
  const response = await skillJson<{ skill: { id: string } }>(
    skillId ? `/api/skills/${skillId}` : "/api/skills",
    {
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
      method: skillId ? "PUT" : "POST",
    },
  );
  return response.skill.id;
}

export async function deleteSkill(skillId: string): Promise<void> {
  await skillJson(`/api/skills/${skillId}`, { method: "DELETE" });
}
