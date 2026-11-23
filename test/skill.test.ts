import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const skill = read("skills/schmear/SKILL.md");
const [, frontmatter = "", body = ""] = skill.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? [];
const field = (key: string) => frontmatter.match(new RegExp(`^${key}: (.+)$`, "m"))?.[1] ?? "";

describe("skills/schmear/SKILL.md", () => {
  it("has the frontmatter the Agent Skills spec requires", () => {
    assert.equal(field("name"), "schmear");
    const description = field("description");
    assert.ok(
      description.length > 0 && description.length <= 1024,
      `description is ${description.length} chars`,
    );
    assert.ok(body.split("\n").length < 500);
  });

  it("names every delegate input field and every task status", () => {
    const schema = read("src/server.ts").match(/z\s*\.object\(\{([\s\S]*?)\n {6}\}\)/)?.[1] ?? "";
    const fields = [...schema.matchAll(/^ {8}(\w+):/gm)].map((m) => m[1]);
    const statuses = [
      ...(read("src/types.ts").match(/status: ("[a-z_]+"(?: \| "[a-z_]+")*);/)?.[1] ?? "").matchAll(
        /"(\w+)"/g,
      ),
    ].map((m) => m[1]);
    assert.deepEqual(fields, ["prompt", "cwd", "tier", "description", "agents", "session"]);
    assert.equal(statuses.length, 4);
    for (const name of [...fields, ...statuses]) {
      assert.ok(body.includes(`\`${name}\``), `SKILL.md does not mention \`${name}\``);
    }
  });
});
