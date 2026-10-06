// GitHub bodies mix markdown with raw HTML: review-bot comments, <details>
// sections, and badges. This remark plugin turns each HTML node into its
// text, so the words stay readable and no markup reaches the page.
interface MarkdownNode {
  children?: MarkdownNode[];
  type: string;
  value?: string;
}

const phrasingParents = new Set([
  "delete",
  "emphasis",
  "heading",
  "link",
  "linkReference",
  "paragraph",
  "strong",
  "tableCell",
]);

const entities: Record<string, string> = { amp: "&", gt: ">", lt: "<", nbsp: " ", quot: "\"" };

// Removing a tag can join the pieces around it into a new one, so tags are
// removed until none are left, and any stray bracket goes too. Entities are
// decoded last; the result is rendered as text, never as markup.
export function htmlText(html: string): string {
  let text = html;
  for (let previous = ""; previous !== text;) {
    previous = text;
    text = text.replace(/<!--[\s\S]*?(?:-->|$)/gu, "").replace(/<[^<>]*>/gu, "");
  }
  return text
    .replace(/[<>]/gu, "")
    .replace(/&(#\d+|#x[\da-f]+|[a-z]+);/giu, (entity, name: string) => {
      if (!name.startsWith("#")) return entities[name.toLowerCase()] ?? entity;
      const codePoint = /^#x/iu.test(name) ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    });
}

function replaceHtml(node: MarkdownNode): void {
  if (!node.children) return;
  const phrasing = phrasingParents.has(node.type);
  node.children = node.children.flatMap((child): MarkdownNode[] => {
    if (child.type !== "html") {
      replaceHtml(child);
      // A paragraph that held only markup, such as a linked badge, is empty now.
      const empty = child.type === "paragraph" && child.children?.every((grandchild) => grandchild.type === "text" && !grandchild.value?.trim());
      return empty ? [] : [child];
    }
    const text = htmlText(child.value ?? "");
    if (phrasing) return text ? [{ type: "text", value: text }] : [];
    const block = text.trim();
    return block ? [{ children: [{ type: "text", value: block }], type: "paragraph" }] : [];
  });
}

export function remarkHtmlAsText() {
  return (tree: MarkdownNode) => {
    replaceHtml(tree);
  };
}
