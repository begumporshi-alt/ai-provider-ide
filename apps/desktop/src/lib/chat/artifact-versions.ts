/**
 * Artifact version history, reconstructed from the transcript.
 *
 * "Preview the previous version" needs the content a file held at each write, and the transcript
 * already has all of it: `write_file` carries the full text, `edit_file` carries the old and new
 * fragments, and both are persisted with the session — so history works retroactively, survives a
 * reload, and needs no new storage or schema. ZCode's own bundle carries the same shape as an
 * explicit model (`artifactId` / `artifactVersionId` / `artifactDisplayName`); this derives it.
 *
 * Reconstruction is a REPLAY, and replay can fail. An edit whose `old` text is not in the content
 * built so far means something changed the file that the transcript never saw — a `run_command`, the
 * user's own editor, or an `apply_patch` (a unified diff, which this does not parse). When that
 * happens the version is still listed, still shown, and marked `exact: false`: the honest answer is
 * "here is the last content we can account for", never a silently wrong page.
 */
import { writtenArtifactPath, type WriteStep } from "./artifacts";

export interface ArtifactVersion {
  /** 1-based, oldest first. Version numbers are what the reader navigates. */
  seq: number;
  /** Text for a UTF-8 write, base64 bytes for a `write_file` with `encoding: "base64"`. */
  content: string;
  encoding: "utf-8" | "base64";
  /** The tool that produced this version, for the label ("written" vs "edited"). */
  tool: string;
  /** Byte count of `content` as it would land on disk. */
  bytes: number;
  /**
   * False when the write that produced this version could not be replayed exactly — see the module
   * note. Shown on the card, never hidden.
   */
  exact: boolean;
}

export interface ArtifactHistory {
  versions: ArtifactVersion[];
  /** How many operations could not be replayed. Zero for a file only this agent has written. */
  unresolved: number;
}

/** Byte length of a version's content as it lands on disk. */
function byteLength(content: string, encoding: "utf-8" | "base64"): number {
  if (encoding === "base64") {
    // Base64 → bytes, discounting padding — the same arithmetic `core/artifact.rs` implies.
    return Math.floor((content.replace(/=+$/, "").length * 3) / 4);
  }
  return new TextEncoder().encode(content).length;
}

/**
 * The version history of one path, oldest first.
 *
 * `runs` is the transcript's tool steps per message, in message order — the same shape
 * `groupToolRuns` produces, so the caller can pass what it already walks. Steps of other tools are
 * ignored; steps that failed are ignored (see `writtenArtifactPath`), because a refused write made
 * no version.
 */
export function artifactHistory(
  runs: ReadonlyMap<number, readonly WriteStep[]>,
  path: string,
): ArtifactHistory {
  const versions: ArtifactVersion[] = [];
  let current: string | null = null;
  let encoding: "utf-8" | "base64" = "utf-8";
  let unresolved = 0;

  const messageIndexes = [...runs.keys()].sort((a, b) => a - b);
  for (const mi of messageIndexes) {
    for (const step of runs.get(mi) ?? []) {
      if (writtenArtifactPath(step) !== path) continue;

      if (step.name === "write_file") {
        const content = typeof step.args.content === "string" ? step.args.content : "";
        encoding = step.args.encoding === "base64" ? "base64" : "utf-8";
        current = content;
        versions.push({
          seq: versions.length + 1,
          content,
          encoding,
          tool: "write_file",
          bytes: byteLength(content, encoding),
          // A whole-file write is exact by construction: the file IS the argument.
          exact: true,
        });
        continue;
      }

      // edit_file
      const oldText = typeof step.args.old === "string" ? step.args.old : "";
      const newText = typeof step.args.new === "string" ? step.args.new : "";
      const replaceAll = step.args.replace_all === true;
      let next: string | null = current;
      let exact = true;

      if (current === null) {
        // An edit with no write before it: the file existed before this conversation, so the
        // content before the edit is unknown and the version below is an approximation.
        exact = false;
      } else if (encoding === "base64") {
        // Editing decoded bytes through a text diff is not something this can replay.
        exact = false;
      } else if (oldText === "" || !current.includes(oldText)) {
        exact = false;
      } else {
        next = replaceAll ? current.split(oldText).join(newText) : current.replace(oldText, newText);
      }

      if (!exact) unresolved += 1;
      current = next;
      if (current === null) continue;

      versions.push({
        seq: versions.length + 1,
        content: current,
        encoding,
        tool: "edit_file",
        bytes: byteLength(current, encoding),
        exact,
      });
    }
  }

  return { versions, unresolved };
}

/**
 * Build the history for every previewable path the transcript wrote, in one walk.
 *
 * One walk for the whole transcript, not one per card: a run that touched a dozen files would
 * otherwise replay the transcript a dozen times on every render.
 */
export function artifactHistories(
  runs: ReadonlyMap<number, readonly WriteStep[]>,
): Map<string, ArtifactHistory> {
  const paths = new Set<string>();
  for (const steps of runs.values()) {
    for (const step of steps) {
      const path = writtenArtifactPath(step);
      if (path) paths.add(path);
    }
  }
  const out = new Map<string, ArtifactHistory>();
  for (const path of paths) out.set(path, artifactHistory(runs, path));
  return out;
}
