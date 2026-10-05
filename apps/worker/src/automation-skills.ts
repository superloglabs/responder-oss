import path from "node:path";
import type { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import type { RuntimeWorkspaceSecret } from "@responder/core/db/workspace-secrets";
import type { RuntimeWorkspaceSkill } from "@responder/core/db/workspace-skills";
import { renderSkillMarkdown, skillInstructionsFileName } from "@responder/core/skills/config";
import { automationWorkspaceRoot } from "./automation-harness.js";

// Each skill is a folder here, outside the checked-out repositories.
export const automationSkillsRoot = `${automationWorkspaceRoot}/.responder/skills`;

export function automationSkillPath(skill: { name: string }): string {
  return `${automationSkillsRoot}/${skill.name}`;
}

// The automation's own secrets and the secrets its skills need, once each.
export function automationRunSecrets(
  secrets: RuntimeWorkspaceSecret[],
  skills: RuntimeWorkspaceSkill[],
): RuntimeWorkspaceSecret[] {
  const byName = new Map<string, RuntimeWorkspaceSecret>();
  for (const secret of [...secrets, ...skills.flatMap((skill) => skill.secrets)]) {
    if (!byName.has(secret.environmentVariable)) byName.set(secret.environmentVariable, secret);
  }
  return [...byName.values()];
}

// Writes every skill folder. The folder is emptied first: a sandbox can hold
// the skills of an earlier turn, and edits and removals since then must apply.
// The agent controls the sandbox between turns, so `.responder` must resolve
// to itself before anything under it is removed.
export async function materializeAutomationSkills(
  session: DaytonaSandboxSession,
  skills: RuntimeWorkspaceSkill[],
): Promise<void> {
  const parent = path.posix.dirname(automationSkillsRoot);
  const output = await session.execCommand({
    cmd: [
      "set -eu",
      `mkdir -p -- '${parent}'`,
      `[ "$(realpath -e -- '${parent}')" = '${parent}' ]`,
      `rm -rf -- '${automationSkillsRoot}'`,
      `mkdir -- '${automationSkillsRoot}'`,
    ].join("\n"),
    maxOutputTokens: 200,
    workdir: automationWorkspaceRoot,
  });
  if (!/(?:^|\n)Process exited with code 0(?:\n|$)/u.test(output)) {
    throw new Error("Unable to prepare the sandbox skills folder");
  }
  for (const skill of skills) {
    const folder = automationSkillPath(skill);
    await session.materializeEntry({
      entry: { type: "file", content: renderSkillMarkdown(skill) },
      path: `${folder}/${skillInstructionsFileName}`,
    });
    for (const file of skill.files) {
      await session.materializeEntry({
        entry: { type: "file", content: file.content },
        path: `${folder}/${file.path}`,
      });
    }
  }
}

export function automationSkillInstructions(skills: RuntimeWorkspaceSkill[]): string[] {
  if (skills.length === 0) return [];
  return [
    `Workspace skills hold instructions and reference files for tasks in this automation. Before a task a skill covers, read its ${skillInstructionsFileName}; the skill's other files are in the same folder.`,
    ...skills.map((skill) => {
      const secrets = skill.secrets.map((secret) => secret.environmentVariable);
      return `- ${skill.name}: ${skill.description} Read ${automationSkillPath(skill)}/${skillInstructionsFileName}.${secrets.length > 0 ? ` Uses ${secrets.join(", ")}.` : ""}`;
    }),
  ];
}
