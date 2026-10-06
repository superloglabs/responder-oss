import { processFile, type FileDiffMetadata } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";
import { missingPatchReason, pullRequestFilePatch } from "../pull-request-diff";
import type { PullRequestFile } from "../pull-requests-api";

function parsedFile(file: PullRequestFile, index: number): FileDiffMetadata | null {
  if (file.patch === null) return null;
  try {
    return processFile(pullRequestFilePatch({ ...file, patch: file.patch }), {
      cacheKey: `pull-request-file-${index}-${file.filename}`,
      isGitDiff: true,
    }) ?? null;
  } catch {
    return null;
  }
}

export function PullRequestFiles({ diffStyle, files, url }: {
  diffStyle: "split" | "unified";
  files: PullRequestFile[];
  url: string;
}) {
  const parsed = useMemo(() => files.map(parsedFile), [files]);
  return <div className="pullRequestFiles">
    {files.map((file, index) => {
      const diff = parsed[index];
      if (diff) {
        return <FileDiff
          className="pullRequestFiles__file"
          fileDiff={diff}
          key={file.filename}
          options={{ diffIndicators: "bars", diffStyle, overflow: "scroll", themeType: "light" }}
        />;
      }
      return <div className="pullRequestFiles__missing" key={file.filename}>
        <code>{file.filename}</code>
        <span>{file.patch === null ? missingPatchReason(file) : "This diff could not be shown."} <a href={`${url}/files`} rel="noreferrer" target="_blank">View on GitHub</a></span>
      </div>;
    })}
  </div>;
}
