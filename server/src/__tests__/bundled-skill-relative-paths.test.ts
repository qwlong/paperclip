import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Agents run in their own project workspace, not in this repo, and resolve a
// skill's relative paths against the skill's base directory. Anything a
// bundled skill tells them to run or read must therefore live inside that
// skill's directory, or agents go searching the whole filesystem for it. It
// must also be a real file: the skill audit rejects symlinks and skill
// copies skip them, so a linked helper disappears wherever a skill is copied.
const SKILLS_ROOT = fileURLToPath(new URL("../../../skills", import.meta.url));
const RELATIVE_REF = /`((?:scripts|references)\/(?!\.\.\.`)[^`\s]+)`/g;

function bundledSkillReferences() {
  return fs
    .readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const skillDir = path.join(SKILLS_ROOT, entry.name);
      const skillFile = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillFile)) return [];
      const refs = new Set(
        [...fs.readFileSync(skillFile, "utf8").matchAll(RELATIVE_REF)].map((m) => m[1]),
      );
      return [...refs].map((ref) => ({ skill: entry.name, skillDir, ref }));
    });
}

const references = bundledSkillReferences();

describe("bundled skill relative paths", () => {
  it("finds the references it is meant to guard", () => {
    expect(references.map((r) => `${r.skill}:${r.ref}`)).toEqual(
      expect.arrayContaining([
        "paperclip:scripts/paperclip-issue-update.sh",
        "paperclip:scripts/paperclip-upload-artifact.sh",
      ]),
    );
  });

  it.each(references)("$skill: $ref resolves inside the skill directory", ({ skillDir, ref }) => {
    const target = path.join(skillDir, ref);
    expect(fs.existsSync(target), `${target} does not exist`).toBe(true);
    expect(fs.lstatSync(target).isSymbolicLink(), `${target} is a symlink`).toBe(false);
    if (ref.startsWith("scripts/")) {
      expect(() => fs.accessSync(target, fs.constants.X_OK), `${target} is not executable`).not.toThrow();
    }
  });
});
