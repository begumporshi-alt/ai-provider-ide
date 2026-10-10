/**
 * artifacts.test.ts — what earns a preview card, and which URLs the host will actually fetch.
 *
 * The kind list mirrors `core/artifact.rs::media_type_for`; the URL rule mirrors
 * `core/egress.rs::is_local`. Both mirrors are the point: a divergence here shows a card that
 * fails when opened, so the pairs that matter are pinned below.
 */
import { describe, expect, it } from "vitest";
import { artifactKindForPath, baseName, findLocalhostUrls, findUrls, isLocalhostUrl } from "./artifacts";

describe("artifactKindForPath", () => {
  it("maps the extensions the host can serve", () => {
    expect(artifactKindForPath("page.html")).toBe("html");
    expect(artifactKindForPath("page.htm")).toBe("html");
    expect(artifactKindForPath("report.pdf")).toBe("pdf");
    expect(artifactKindForPath("logo.png")).toBe("image");
    expect(artifactKindForPath("shot.jpeg")).toBe("image");
    expect(artifactKindForPath("icon.svg")).toBe("image");
  });

  it("is case-insensitive and looks at the last extension only", () => {
    expect(artifactKindForPath("REPORT.PDF")).toBe("pdf");
    expect(artifactKindForPath("archive.tar.gz")).toBeNull();
    expect(artifactKindForPath("v1.2/notes.html")).toBe("html");
  });

  it("refuses what the host would refuse", () => {
    // These are the host's answer too — a card for one of them would fail on open.
    for (const p of ["main.rs", "app.tsx", "data.json", "secrets.env", "notes.txt", "run.sh"]) {
      expect(artifactKindForPath(p)).toBeNull();
    }
  });

  it("handles degenerate names without inventing a kind", () => {
    expect(artifactKindForPath("")).toBeNull();
    expect(artifactKindForPath("   ")).toBeNull();
    expect(artifactKindForPath("noext")).toBeNull();
    expect(artifactKindForPath("trailing.")).toBeNull();
  });
});

describe("baseName", () => {
  it("takes the last path segment", () => {
    expect(baseName("a/b/c.html")).toBe("c.html");
    expect(baseName("page.html")).toBe("page.html");
    expect(baseName("a/b/")).toBe("b");
  });
});

describe("URLs", () => {
  it("recognizes the loopback hosts the egress policy permits", () => {
    expect(isLocalhostUrl("http://localhost:3000")).toBe(true);
    expect(isLocalhostUrl("http://127.0.0.1:8080/app")).toBe(true);
    expect(isLocalhostUrl("http://127.1.2.3/")).toBe(true);
    expect(isLocalhostUrl("https://localhost")).toBe(true);
    expect(isLocalhostUrl("http://[::1]:3000")).toBe(true);
  });

  it("rejects everything else — those are browser-only", () => {
    expect(isLocalhostUrl("https://example.com")).toBe(false);
    expect(isLocalhostUrl("https://localhost.evil.com")).toBe(false);
    expect(isLocalhostUrl("http://notlocalhost")).toBe(false);
    expect(isLocalhostUrl("file:///etc/hosts")).toBe(false);
    expect(isLocalhostUrl("not a url")).toBe(false);
  });

  it("finds URLs in prose, trimming the sentence's punctuation", () => {
    // The trailing full stop is the case that breaks a naive match: a fetch of
    // "…:3000." fails on the host, because the dot is part of the URL it was handed.
    const text = "Started it at http://localhost:3000, see http://localhost:3000/health.";
    expect(findUrls(text)).toEqual(["http://localhost:3000", "http://localhost:3000/health"]);
  });

  it("de-duplicates and keeps order", () => {
    const text = "b http://localhost:1 then a http://localhost:2 then b http://localhost:1";
    expect(findUrls(text)).toEqual(["http://localhost:1", "http://localhost:2"]);
  });

  it("offers a preview only for the hosts the host would fetch", () => {
    const text = "docs at https://example.com/x and the app at http://127.0.0.1:5173/";
    expect(findLocalhostUrls(text)).toEqual(["http://127.0.0.1:5173/"]);
  });

  it("finds nothing in prose that has no URL", () => {
    expect(findLocalhostUrls("no links here, just words")).toEqual([]);
  });
});
