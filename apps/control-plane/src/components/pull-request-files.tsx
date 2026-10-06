import { processFile, type FileDiffMetadata } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { estimatedDiffHeight, missingPatchReason, pullRequestFilePatch } from "../pull-request-diff";
import type { PullRequestFile } from "../pull-requests-api";

function parsedFile(file: PullRequestFile & { patch: string }, index: number): FileDiffMetadata | null {
  const patch = pullRequestFilePatch(file);
  if (patch === null) return null;
  try {
    return processFile(patch, { cacheKey: `pull-request-file-${index}-${file.filename}`, isGitDiff: true }) ?? null;
  } catch {
    return null;
  }
}

function MissingDiff({ file, reason, url }: { file: PullRequestFile; reason: string; url: string }) {
  return <div className="pullRequestFiles__missing">
    <code>{file.filename}</code>
    <span>{reason} <a href={`${url}/files`} rel="noreferrer" target="_blank">View on GitHub</a></span>
  </div>;
}

// The page scrolls inside the workspace, not the window. Observing against the
// window would clip the margin that renders diffs before they scroll in.
function scrollingAncestor(node: HTMLElement): HTMLElement | null {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll") return parent;
  }
  return null;
}

// A pull request can change thousands of files, so each diff is parsed and
// rendered only when it comes near the viewport. Until then it holds its
// estimated height, and once rendered it stays.
function DeferredFileDiff({ diffStyle, file, index, patch, url }: {
  diffStyle: "split" | "unified";
  file: PullRequestFile;
  index: number;
  patch: string;
  url: string;
}) {
  const placeholder = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const node = placeholder.current;
    if (near || !node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true);
    }, { root: scrollingAncestor(node), rootMargin: "1200px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);
  const diff = useMemo(() => near ? parsedFile({ ...file, patch }, index) : null, [file, index, near, patch]);

  if (!near) {
    return <div className="pullRequestFiles__placeholder" ref={placeholder} style={{ height: estimatedDiffHeight({ ...file, patch }) }}>
      <code>{file.filename}</code>
    </div>;
  }
  if (!diff) return <MissingDiff file={file} reason="This diff could not be shown." url={url} />;
  return <FileDiff
    className="pullRequestFiles__file"
    fileDiff={diff}
    options={{ diffIndicators: "bars", diffStyle, overflow: "scroll", themeType: "light" }}
  />;
}

export function PullRequestFiles({ diffStyle, files, url }: {
  diffStyle: "split" | "unified";
  files: PullRequestFile[];
  url: string;
}) {
  return <div className="pullRequestFiles">
    {files.map((file, index) => file.patch === null
      ? <MissingDiff file={file} key={file.filename} reason={missingPatchReason(file)} url={url} />
      : <DeferredFileDiff diffStyle={diffStyle} file={file} index={index} key={file.filename} patch={file.patch} url={url} />)}
  </div>;
}
