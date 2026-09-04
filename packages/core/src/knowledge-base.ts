import { z } from "zod";

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use a lowercase kebab-case slug");

const sourcePathsSchema = z
  .array(z.string().trim().min(1).max(500))
  .max(30)
  .refine(
    (paths) => new Set(paths).size === paths.length,
    "Source paths must be unique",
  )
  .default([]);

export const codebaseKnowledgeDocumentSchema = z.object({
  slug: slugSchema,
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(500),
  markdown: z.string().trim().min(1).max(30_000),
  sourcePaths: sourcePathsSchema,
});

function restrictedD2Issue(source: string): string | null {
  const nodeIds = new Set<string>();
  const referencedIds = new Set<string>();
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const edge = /^([a-z][a-z0-9_]*)\s*->\s*([a-z][a-z0-9_]*)(?:\s*:\s*(.+))?$/u.exec(line);
    if (edge) {
      referencedIds.add(edge[1]!);
      referencedIds.add(edge[2]!);
      continue;
    }
    const node = /^([a-z][a-z0-9_]*)\s*:\s*(.+)$/u.exec(line);
    if (node) {
      nodeIds.add(node[1]!);
      continue;
    }
    return `Unsupported D2 line: ${line.slice(0, 120)}`;
  }
  if (nodeIds.size < 2) return "A diagram needs at least two declared nodes";
  for (const id of referencedIds) {
    if (!nodeIds.has(id)) return `D2 edge references undeclared node: ${id}`;
  }
  return null;
}

export const restrictedD2SourceSchema = z
  .string()
  .trim()
  .min(1)
  .max(20_000)
  .superRefine((source, context) => {
    const issue = restrictedD2Issue(source);
    if (issue) context.addIssue({ code: "custom", message: issue });
  });

export const codebaseKnowledgeDiagramSchema = z.object({
  slug: slugSchema,
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(500),
  d2: restrictedD2SourceSchema,
  sourcePaths: sourcePathsSchema,
});

export const codebaseKnowledgeContentSchema = z
  .object({
    overview: z.string().trim().min(1).max(1_000),
    documents: z.array(codebaseKnowledgeDocumentSchema).min(8).max(12),
    diagrams: z.array(codebaseKnowledgeDiagramSchema).min(8).max(12),
  })
  .superRefine((content, context) => {
    for (const [kind, items] of [
      ["documents", content.documents],
      ["diagrams", content.diagrams],
    ] as const) {
      const slugs = new Set<string>();
      for (const [index, item] of items.entries()) {
        if (slugs.has(item.slug)) {
          context.addIssue({
            code: "custom",
            message: `${kind} must use unique slugs`,
            path: [kind, index, "slug"],
          });
        }
        slugs.add(item.slug);
      }
    }
  });

export const codebaseKnowledgeRepositoryRevisionSchema = z.object({
  repository: z.string().trim().min(1).max(300),
  branch: z.string().trim().min(1).max(300),
  sha: z.string().regex(/^[a-f0-9]{40}$/i),
});

export type CodebaseKnowledgeContent = z.infer<
  typeof codebaseKnowledgeContentSchema
>;
export type CodebaseKnowledgeDocument = z.infer<
  typeof codebaseKnowledgeDocumentSchema
>;
export type CodebaseKnowledgeDiagram = z.infer<
  typeof codebaseKnowledgeDiagramSchema
>;
export type CodebaseKnowledgeRepositoryRevision = z.infer<
  typeof codebaseKnowledgeRepositoryRevisionSchema
>;

const privateKeyPattern =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const providerTokenPattern =
  /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g;
const jwtPattern = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const credentialAssignmentPattern =
  /(\b(?:api[_-]?key|authorization|credential|password|private[_-]?key|secret|token)\b\s*[:=]\s*)(?:"[^"\n]{8,}"|'[^'\n]{8,}'|[^\s,;]{8,})/gi;

export function redactCodebaseKnowledgeText(value: string): string {
  return value
    .replace(privateKeyPattern, "[redacted]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(providerTokenPattern, "[redacted]")
    .replace(jwtPattern, "[redacted]")
    .replace(credentialAssignmentPattern, "$1[redacted]")
    .replace(/:\/\/([^/@\s]+):([^/@\s]+)@/g, "://[redacted]@");
}

export function sanitizeCodebaseKnowledgeContent(
  content: CodebaseKnowledgeContent,
): CodebaseKnowledgeContent {
  const sanitizeItem = <T extends CodebaseKnowledgeDocument | CodebaseKnowledgeDiagram>(
    item: T,
  ): T => ({
    ...item,
    title: redactCodebaseKnowledgeText(item.title),
    summary: redactCodebaseKnowledgeText(item.summary),
    sourcePaths: item.sourcePaths.map(redactCodebaseKnowledgeText),
    ...(item && "markdown" in item
      ? { markdown: redactCodebaseKnowledgeText(item.markdown) }
      : { d2: redactCodebaseKnowledgeText(item.d2) }),
  } as T);

  return codebaseKnowledgeContentSchema.parse({
    overview: redactCodebaseKnowledgeText(content.overview),
    documents: content.documents.map(sanitizeItem),
    diagrams: content.diagrams.map(sanitizeItem),
  });
}
