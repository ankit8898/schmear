import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { candidates, DEFAULT_TIERS, parseTiers, pinned } from "../src/tiers.ts";
import { agentOf, LANE_KEYS } from "../src/types.ts";

const guide = readFileSync(fileURLToPath(new URL("../docs/guide.md", import.meta.url)), "utf8");

describe("DEFAULT_TIERS", () => {
  it("deep-equals the guide's default tier list", () => {
    const json = guide
      .split("<summary>Default tier list</summary>")[1]
      ?.match(/```json\n([\s\S]*?)\n```/)?.[1];
    assert.deepEqual(DEFAULT_TIERS, JSON.parse(json ?? ""));
  });

  it("parses cleanly", () => {
    const parsed = parseTiers(DEFAULT_TIERS);
    assert.equal(parsed.length, 4);
    assert.deepEqual(parsed[0][0], { key: "claude", model: "haiku", effort: "medium" });
    assert.deepEqual(parsed[3], [
      { key: "claude", model: "fable", effort: "medium" },
      { key: "codex", model: "gpt-6.2-sol", effort: "xhigh" },
      { key: "agy-gemini", model: "gemini-4-carbon", effort: "medium" },
      { key: "claude-credits", model: "fable", effort: "medium" },
      { key: "gemini-credits", model: "gemini-4-carbon", effort: "high" },
    ]);
  });

  it("has one gemini-credits entry per tier, mirroring agy-gemini with medium raised to high", () => {
    const gemini = parseTiers(DEFAULT_TIERS).map((t) => t.filter((e) => e.key === "gemini-credits"));
    assert.deepEqual(
      gemini.map((g) => g.map((e) => `${e.model}@${e.effort}`)),
      [
        ["gemini-4-hydrogen@high"],
        ["gemini-4-hydrogen@high"],
        ["gemini-4-hydrogen@high"],
        ["gemini-4-carbon@high"],
      ],
    );
  });
});

describe("agentOf", () => {
  it("maps every lane key to its agent", () => {
    assert.deepEqual(
      LANE_KEYS.map((k) => agentOf(k)),
      ["claude", "codex", "grok", "agy", "agy", "agy", "opencode", "claude", "agy"],
    );
  });
});

describe("parseTiers", () => {
  const shape = {
    message: 'tiers must be a non-empty list of tiers, each a non-empty list of "key:model@effort" strings',
  };

  it("rejects non-array, empty, non-array tier, and non-string entry", () => {
    for (const bad of [
      null,
      undefined,
      {},
      { claude: { "1": { medium: { model: "haiku", effort: "medium" } } } },
      "claude:haiku@medium",
      [],
      ["claude:haiku@medium"],
      [{}],
      [[123]],
      [[null]],
      [["claude:haiku@medium"], [{ model: "sonnet", effort: "medium" }]],
    ]) {
      assert.throws(() => parseTiers(bad), shape);
    }
  });

  it("rejects an empty tier with its 1-based tier number", () => {
    assert.throws(() => parseTiers([[]]), { message: "tier 1 is empty" });
    assert.throws(() => parseTiers([["claude:haiku@medium"], []]), { message: "tier 2 is empty" });
  });

  it("rejects entries not matching key:model@effort", () => {
    for (const e of [
      "claude:haiku",
      "haiku@medium",
      ":haiku@medium",
      "claude:@medium",
      "claude:haiku@",
      "claude:haiku@med ium",
      "claude:haiku@a@b",
      "",
    ]) {
      assert.throws(() => parseTiers([[e]]), {
        message: `tier 1 entry "${e}": expected "key:model@effort"`,
      });
    }
  });

  it("rejects unknown lane keys", () => {
    assert.throws(() => parseTiers([["claude:haiku@medium"], ["openai:gpt-5@medium"]]), {
      message:
        'tier 2 entry "openai:gpt-5@medium": unknown lane key "openai" (one of claude, codex, grok, agy-gemini, agy-argon, agy-3p, opencode-go, claude-credits, gemini-credits)',
    });
  });

  it("rejects duplicate key:model in the same tier", () => {
    assert.throws(() => parseTiers([["claude:sonnet@low", "claude:sonnet@high"]]), {
      message: 'tier 1 entry "claude:sonnet@high": claude:sonnet is listed twice in this tier',
    });
  });

  it("allows the same key:model in different tiers", () => {
    const parsed = parseTiers([["claude:sonnet@low"], ["claude:sonnet@high"]]);
    assert.deepEqual(parsed, [
      [{ key: "claude", model: "sonnet", effort: "low" }],
      [{ key: "claude", model: "sonnet", effort: "high" }],
    ]);
  });
});

describe("candidates", () => {
  const defaultList = parseTiers(DEFAULT_TIERS);

  it("never returns a tier below the task's, and exact tier comes first", () => {
    for (const tier of [1, 2, 3, 4]) {
      const lanes = candidates(tier, defaultList, {}, "default");
      assert.ok(lanes.length > 0);
      assert.ok(lanes.every((l) => l.tier >= tier));
      assert.deepEqual(
        lanes.map((l) => l.tier),
        lanes.map((l) => l.tier).sort((a, b) => a - b),
      );
      assert.equal(lanes[0]?.tier, tier);
    }
  });

  it("orders exact tier, then higher tiers, preserving list order within a tier", () => {
    const list = parseTiers([
      ["codex:c@low", "claude:a@medium"],
      ["claude:b@high", "codex:d@max"],
    ]);
    assert.deepEqual(
      candidates(1, list, {}, "default").map((l) => l.id),
      ["codex@default:c", "claude@default:a", "claude@default:b", "codex@default:d"],
    );
  });

  it("builds the lane from the entry and carries its effort", () => {
    const [lane] = candidates(2, defaultList, {}, "default");
    assert.deepEqual(lane, {
      id: "claude@default:sonnet",
      agent: "claude",
      account: "default",
      key: "claude",
      tier: 2,
      model: "sonnet",
      effort: "medium",
    });
    assert.equal(candidates(1, defaultList, {}, "default").find((l) => l.key === "agy-argon")?.agent, "agy");
    assert.equal(
      candidates(3, defaultList, {}, "default").find((l) => l.key === "agy-gemini")?.id,
      "agy-gemini@default:gemini-4-hydrogen",
    );
  });

  it("keeps the lowest tier per key:model", () => {
    const list = parseTiers([["claude:a@low"], ["claude:a@high"], ["claude:b@medium"]]);
    assert.deepEqual(
      candidates(1, list, {}, "default").map((l) => [l.id, l.tier, l.effort]),
      [
        ["claude@default:a", 1, "low"],
        ["claude@default:b", 3, "medium"],
      ],
    );
    assert.deepEqual(
      candidates(2, list, {}, "default").map((l) => [l.id, l.tier, l.effort]),
      [
        ["claude@default:a", 2, "high"],
        ["claude@default:b", 3, "medium"],
      ],
    );
  });

  it("keeps the same model on different keys", () => {
    const list = parseTiers([["agy-gemini:m@low", "agy-argon:m@medium"]]);
    assert.deepEqual(
      candidates(1, list, {}, "default").map((l) => l.id),
      ["agy-gemini@default:m", "agy-argon@default:m"],
    );
  });

  it("drops a model missing from a known offered list only", () => {
    const list = parseTiers([["claude:a@low", "codex:c@max"], ["claude:b@medium"]]);
    const ids = (offered: Record<string, string[]>) =>
      candidates(1, list, offered, "default").map((l) => l.id);
    assert.deepEqual(ids({ "claude@default": ["b"] }), ["codex@default:c", "claude@default:b"]);
    assert.deepEqual(ids({}), ["claude@default:a", "codex@default:c", "claude@default:b"]);
    assert.deepEqual(ids({ "claude@default": [], "codex@default": ["c"] }), ["codex@default:c"]);
  });

  it("keys the offered list by key id, so claude-credits and claude differ", () => {
    const list = parseTiers([["claude:a@low", "claude-credits:a@low"]]);
    const ids = (offered: Record<string, string[]>) =>
      candidates(1, list, offered, "default").map((l) => l.id);
    assert.deepEqual(ids({ "claude-credits@default": ["b"] }), ["claude@default:a"]);
    assert.deepEqual(ids({ "claude@default": ["b"] }), ["claude-credits@default:a"]);
  });

  it("with an account, ids and the offered lookup use the key id", () => {
    const list = parseTiers([["claude:a@low", "claude:b@low", "codex:c@max"]]);
    const lanes = candidates(1, list, { "claude@default": [], "claude@work": ["b"] }, "work");
    assert.deepEqual(
      lanes.map((l) => [l.id, l.account]),
      [
        ["claude@work:b", "work"],
        ["codex@work:c", "work"],
      ],
    );
    assert.equal(lanes[0]?.key, "claude");
  });

  it("works on a 2-tier list", () => {
    const two = parseTiers([
      ["claude:sonnet@low", "codex:gpt-5.6-terra@medium", "agy-gemini:gemini-4-hydrogen@medium"],
      ["claude:opus@high", "agy-3p:claude-opus-5-5@high", "agy-gemini:gemini-4-neon@high"],
    ]);
    assert.deepEqual(
      candidates(2, two, {}, "default").map((l) => [l.id, l.tier, l.effort]),
      [
        ["claude@default:opus", 2, "high"],
        ["agy-3p@default:claude-opus-5-5", 2, "high"],
        ["agy-gemini@default:gemini-4-neon", 2, "high"],
      ],
    );
    assert.equal(candidates(1, two, {}, "default").length, 6);
  });

  it("works on a 10-tier list", () => {
    const ten = parseTiers(Array.from({ length: 10 }, (_, i) => [`claude:m${i + 1}@medium`]));
    const all = candidates(1, ten, {}, "default");
    assert.equal(all.length, 10);
    assert.deepEqual(
      all.map((l) => l.tier),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    assert.deepEqual(candidates(10, ten, {}, "default"), [
      {
        id: "claude@default:m10",
        agent: "claude",
        account: "default",
        key: "claude",
        tier: 10,
        model: "m10",
        effort: "medium",
      },
    ]);
  });
});

describe("pinned", () => {
  const list = parseTiers([["agy-gemini:gemini-4-hydrogen@medium"]]);
  const agyKeys = ["agy-3p", "agy-gemini", "agy-argon"] as const;
  const ids = (offered: Record<string, string[]>, model = "gemini-4-neon") =>
    pinned(2, model, "high", list, offered, "default", agyKeys).map((l) => l.id);

  it("takes each key whose known offered list has the model, in LANE_KEYS order, at the task's tier", () => {
    const both = { "claude@default": ["m"], "codex@default": ["m"], "grok@default": ["x"] };
    assert.deepEqual(
      pinned(1, "m", "low", list, both, "default", ["grok", "codex", "claude"]).map((l) => l.id),
      ["claude@default:m", "codex@default:m"],
    );
    const offered = { "agy-gemini@default": ["gemini-4-neon"] };
    assert.deepEqual(pinned(2, "gemini-4-neon", "high", list, offered, "default", ["agy-gemini"]), [
      {
        id: "agy-gemini@default:gemini-4-neon",
        agent: "agy",
        account: "default",
        key: "agy-gemini",
        tier: 2,
        model: "gemini-4-neon",
        effort: "high",
      },
    ]);
    assert.deepEqual(ids({ "agy-gemini@default": ["gemini-4-hydrogen"] }), []);
  });

  it("with no known list, takes a key only when some tier entry names it with the model", () => {
    assert.deepEqual(ids({}), []);
    assert.deepEqual(ids({}, "gemini-4-hydrogen"), ["agy-gemini@default:gemini-4-hydrogen"]);
  });

  it("runs an agy model only on the key of the quota group it spends, though every agy key offers it", () => {
    const all = ["gemini-4-neon", "gemini-4-argon", "claude-opus-5-5"];
    const offered = { "agy-gemini@default": all, "agy-argon@default": all, "agy-3p@default": all };
    const keyOf = (model: string) =>
      pinned(1, model, "high", list, offered, "default", agyKeys).map((l) => l.key);
    assert.deepEqual(keyOf("gemini-4-neon"), ["agy-gemini"]);
    assert.deepEqual(keyOf("claude-opus-5-5"), ["agy-3p"]);
    assert.deepEqual(keyOf("gemini-4-argon"), ["agy-argon"]);
  });

  it("takes a credit key only through a tier entry of its own key, whatever its offered list says", () => {
    const custom = parseTiers([["claude:opus@medium"]]);
    const credit = (model: string, tiers: typeof custom, offered: Record<string, string[]>) =>
      pinned(1, model, "high", tiers, offered, "default", ["claude-credits", "gemini-credits"]).map(
        (l) => l.id,
      );
    assert.deepEqual(credit("opus", custom, { "claude-credits@default": ["opus"] }), []);
    assert.deepEqual(
      credit("claude-opus-5-5", custom, { "gemini-credits@default": ["claude-opus-5-5"] }),
      [],
    );
    assert.deepEqual(credit("opus", parseTiers(DEFAULT_TIERS), { "claude-credits@default": ["opus"] }), [
      "claude-credits@default:opus",
    ]);
  });
});
