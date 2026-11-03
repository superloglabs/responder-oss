import { z } from "zod";
import {
  deleteWorkspaceMemory,
  getWorkspaceMemory,
  importWorkspaceMemories,
  listWorkspaceMemories,
  updateWorkspaceMemory,
  WorkspaceMemoryError,
} from "../../../../packages/core/src/db/workspace-memories.js";
import {
  memoryImportMaxCount,
  memoryInputSchema,
  memoryTypes,
  workspaceMemoriesMaxCount,
} from "../../../../packages/core/src/memories/config.js";
import { controlPlaneBaseUrl } from "../integrations/urls.js";
import { defineOperation, ManagementError } from "./operation.js";

// Facts members save for agents. Every automation run and tag mode thread
// reads them; runs cannot change them. People import them from Claude Code
// or Codex through these tools.

const memoryId = z.uuid().describe("The memory's ID.");

const memorySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.enum(memoryTypes),
  updatedAt: z.string(),
  updatedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  url: z.string(),
});

const memoryDetailSchema = memorySummarySchema.extend({ body: z.string() });

function memoryUrl(id?: string): string {
  return new URL(id ? `/memory/${id}` : "/memory", controlPlaneBaseUrl()).toString();
}

const memoryNotFound = () => new ManagementError(404, "Memory not found", "memory_not_found");

function memoryError(error: unknown): never {
  if (!(error instanceof WorkspaceMemoryError)) throw error;
  throw new ManagementError(error.code === "credential" ? 422 : 409, error.message, error.code);
}

export const memoryOperations = [
  defineOperation({
    name: "list_memories",
    summary: "List memories",
    description: `Lists the workspace's memories: facts members saved for agents. Every automation run and tag mode thread reads them. A workspace keeps at most ${workspaceMemoriesMaxCount}.`,
    method: "GET",
    path: "/memories",
    tag: "Memory",
    effect: "read",
    requiresAutomations: true,
    input: z.object({}),
    output: z.object({ memories: z.array(memorySummarySchema) }),
    async run(context) {
      const memories = await listWorkspaceMemories(context.organizationId);
      return { memories: memories.map((memory) => ({ ...memory, url: memoryUrl(memory.id) })) };
    },
  }),
  defineOperation({
    name: "get_memory",
    summary: "Get a memory",
    description: "Returns a memory with its body.",
    method: "GET",
    path: "/memories/{memoryId}",
    tag: "Memory",
    effect: "read",
    requiresAutomations: true,
    input: z.object({ memoryId }),
    output: z.object({ memory: memoryDetailSchema }),
    async run(context, input) {
      const memory = await getWorkspaceMemory(context.organizationId, input.memoryId);
      if (!memory) throw memoryNotFound();
      return { memory: { ...memory, url: memoryUrl(memory.id) } };
    },
  }),
  defineOperation({
    name: "import_memories",
    summary: "Import memories",
    description: `Adds memories to the workspace, such as ones from Claude Code or Codex. Each is a Claude Code memory file: its front matter's name, description, and type, and its body. Memories are shared with the whole workspace and read by every automation run and tag mode thread, so import only facts about the team's systems and work, and never credentials. A memory whose name already exists is left unchanged and listed in \`existing\`. Up to ${memoryImportMaxCount} per call.`,
    method: "POST",
    path: "/memories/import",
    tag: "Memory",
    effect: "write",
    requiresAutomations: true,
    input: z.object({
      memories: z
        .array(memoryInputSchema)
        .min(1)
        .max(memoryImportMaxCount)
        .refine((memories) => new Set(memories.map((memory) => memory.name)).size === memories.length, "Each memory needs a different name"),
    }),
    output: z.object({
      created: z.array(z.object({ id: z.string(), name: z.string() })),
      existing: z.array(z.string()),
      url: z.string(),
    }),
    async run(context, input) {
      try {
        const result = await importWorkspaceMemories({
          organizationId: context.organizationId,
          userId: context.user.id,
          memories: input.memories,
        });
        return { ...result, url: memoryUrl() };
      } catch (error) {
        memoryError(error);
      }
    },
  }),
  defineOperation({
    name: "update_memory",
    summary: "Change a memory",
    description: "Changes the fields you send and keeps the rest. `body` replaces the whole body.",
    method: "PATCH",
    path: "/memories/{memoryId}",
    tag: "Memory",
    effect: "destructive",
    requiresAutomations: true,
    input: z.object({
      memoryId,
      name: memoryInputSchema.shape.name.optional(),
      description: memoryInputSchema.shape.description.optional(),
      type: z.enum(memoryTypes).optional().describe(memoryInputSchema.shape.type.description ?? ""),
      body: memoryInputSchema.shape.body.optional(),
    }),
    output: z.object({ memory: memoryDetailSchema }),
    async run(context, input) {
      const { memoryId: id, ...changes } = input;
      if (Object.values(changes).every((value) => value === undefined)) {
        throw new ManagementError(400, "Send at least one field to change.", "nothing_to_update");
      }
      const current = await getWorkspaceMemory(context.organizationId, id);
      if (!current) throw memoryNotFound();
      const defined = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
      try {
        const updated = await updateWorkspaceMemory({
          organizationId: context.organizationId,
          memoryId: id,
          userId: context.user.id,
          memory: memoryInputSchema.parse({ ...current, ...defined }),
        });
        if (!updated) throw memoryNotFound();
      } catch (error) {
        if (error instanceof ManagementError) throw error;
        memoryError(error);
      }
      const memory = await getWorkspaceMemory(context.organizationId, id);
      if (!memory) throw memoryNotFound();
      return { memory: { ...memory, url: memoryUrl(memory.id) } };
    },
  }),
  defineOperation({
    name: "delete_memory",
    summary: "Delete a memory",
    description: "Deletes a memory. Runs that start afterward no longer read it.",
    method: "DELETE",
    path: "/memories/{memoryId}",
    tag: "Memory",
    effect: "destructive",
    requiresAutomations: true,
    input: z.object({ memoryId }),
    output: z.object({ deleted: z.literal(true) }),
    async run(context, input) {
      if (!(await deleteWorkspaceMemory({ organizationId: context.organizationId, memoryId: input.memoryId }))) {
        throw memoryNotFound();
      }
      return { deleted: true as const };
    },
  }),
];
