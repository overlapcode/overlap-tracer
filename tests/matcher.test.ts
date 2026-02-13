import { describe, it, expect } from "bun:test";
import { matchRepo, stripFilePath } from "../src/matcher";

describe("matchRepo", () => {
  const repoLists = new Map<string, string[]>([
    ["https://team-a.workers.dev", ["crop2cash", "crop2cash-infra", "crop2cash-mobile"]],
    ["https://team-b.workers.dev", ["socialbriefhq", "socialbriefhq-web"]],
  ]);

  it("matches by basename", () => {
    const gitCache = new Map<string, string>();
    const matches = matchRepo("/Users/michael/work/crop2cash", repoLists, gitCache);
    expect(matches).toEqual([{ teamUrl: "https://team-a.workers.dev", repoName: "crop2cash" }]);
  });

  it("matches hyphenated project names correctly", () => {
    const gitCache = new Map<string, string>();
    const matches = matchRepo("/Users/michael/work/crop2cash-infra", repoLists, gitCache);
    expect(matches).toEqual([{ teamUrl: "https://team-a.workers.dev", repoName: "crop2cash-infra" }]);
  });

  it("returns empty for unrecognized repos", () => {
    const gitCache = new Map<string, string>();
    const matches = matchRepo("/Users/michael/personal/my-blog", repoLists, gitCache);
    expect(matches).toEqual([]);
  });

  it("matches from git remote cache", () => {
    const gitCache = new Map<string, string>([
      ["/Users/michael/renamed-folder", "socialbriefhq"],
    ]);
    const matches = matchRepo("/Users/michael/renamed-folder", repoLists, gitCache);
    expect(matches).toEqual([{ teamUrl: "https://team-b.workers.dev", repoName: "socialbriefhq" }]);
  });

  it("matches same repo to multiple teams", () => {
    const multiTeamRepos = new Map<string, string[]>([
      ["https://team-a.workers.dev", ["shared-lib"]],
      ["https://team-b.workers.dev", ["shared-lib"]],
    ]);
    const gitCache = new Map<string, string>();
    const matches = matchRepo("/work/shared-lib", multiTeamRepos, gitCache);
    expect(matches).toHaveLength(2);
    expect(matches[0].teamUrl).toBe("https://team-a.workers.dev");
    expect(matches[1].teamUrl).toBe("https://team-b.workers.dev");
  });

  it("handles deeply nested paths", () => {
    const gitCache = new Map<string, string>();
    const matches = matchRepo("/Users/michael/dev/projects/clients/crop2cash", repoLists, gitCache);
    expect(matches).toEqual([{ teamUrl: "https://team-a.workers.dev", repoName: "crop2cash" }]);
  });
});

describe("stripFilePath", () => {
  it("strips cwd prefix from absolute paths", () => {
    expect(stripFilePath("/Users/michael/work/crop2cash/src/index.ts", "/Users/michael/work/crop2cash"))
      .toBe("src/index.ts");
  });

  it("handles cwd with trailing slash", () => {
    expect(stripFilePath("/Users/michael/work/crop2cash/src/index.ts", "/Users/michael/work/crop2cash/"))
      .toBe("src/index.ts");
  });

  it("passes through sentinel values", () => {
    expect(stripFilePath("(bash)", "/Users/michael/work")).toBe("(bash)");
    expect(stripFilePath("(grep)", "/Users/michael/work")).toBe("(grep)");
    expect(stripFilePath("(glob)", "/Users/michael/work")).toBe("(glob)");
  });

  it("returns path unchanged if no cwd", () => {
    expect(stripFilePath("/Users/michael/work/crop2cash/src/index.ts", undefined))
      .toBe("/Users/michael/work/crop2cash/src/index.ts");
  });

  it("returns path unchanged if cwd doesn't match", () => {
    expect(stripFilePath("/Users/michael/other/file.ts", "/Users/michael/work"))
      .toBe("/Users/michael/other/file.ts");
  });

  it("returns relative paths unchanged", () => {
    expect(stripFilePath("src/index.ts", "/Users/michael/work")).toBe("src/index.ts");
  });
});
