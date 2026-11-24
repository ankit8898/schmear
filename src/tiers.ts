import {
  type AgentId,
  type Entry,
  keyId,
  LANE_KEYS,
  type Lane,
  type LaneKey,
  type Offered,
  type TierList,
} from "./types.ts";

/** Ratings in docs/research/model-tiers.md §3; docs/guide.md prints this list, and a test keeps them equal. */
export const DEFAULT_TIERS: string[][] = [
  [
    "claude:haiku@medium",
    "codex:gpt-6-luna@max",
    "grok:grok-4.7@medium",
    "agy-gemini:gemini-4-hydrogen@medium",
    "agy-argon:gemini-4-argon@medium",
    "agy-3p:claude-sonnet-5-5@medium",
    "claude-credits:haiku@medium",
  ],
  [
    "claude:sonnet@medium",
    "codex:gpt-6.1-terra@medium",
    "agy-gemini:gemini-4-hydrogen@medium",
    "agy-argon:gemini-4-argon@medium",
    "agy-3p:claude-sonnet-5-5@medium",
    "claude-credits:sonnet@medium",
  ],
  [
    "claude:opus@medium",
    "codex:gpt-6.1-terra@max",
    "agy-gemini:gemini-4-neon@medium",
    "agy-argon:gemini-4-argon@medium",
    "agy-3p:claude-opus-5-5@medium",
    "claude-credits:opus@medium",
  ],
  ["claude:fable@medium", "claude-credits:fable@medium"],
];

const SHAPE_ERROR =
  'tiers must be a non-empty list of tiers, each a non-empty list of "key:model@effort" strings';
const ENTRY_RE = /^([^:@\s]+):([^@\s]+)@([^@\s]+)$/;
const LANE_KEY_SET: ReadonlySet<string> = new Set(LANE_KEYS);

/** Throws `tier <t> entry "<entry>": <why>` or the shape message. */
export function parseTiers(raw: unknown): TierList {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(SHAPE_ERROR);
  const out: TierList = [];
  for (let i = 0; i < raw.length; i++) {
    const tier = raw[i];
    const t = i + 1;
    if (!Array.isArray(tier)) throw new Error(SHAPE_ERROR);
    if (tier.length === 0) throw new Error(`tier ${t} is empty`);
    const entries: Entry[] = [];
    const seen = new Set<string>();
    for (const e of tier) {
      if (typeof e !== "string") throw new Error(SHAPE_ERROR);
      const match = ENTRY_RE.exec(e);
      if (!match) throw new Error(`tier ${t} entry "${e}": expected "key:model@effort"`);
      const [, key, model, effort] = match;
      if (!LANE_KEY_SET.has(key)) {
        throw new Error(`tier ${t} entry "${e}": unknown lane key "${key}" (one of ${LANE_KEYS.join(", ")})`);
      }
      const id = `${key}:${model}`;
      if (seen.has(id)) {
        throw new Error(`tier ${t} entry "${e}": ${id} is listed twice in this tier`);
      }
      seen.add(id);
      entries.push({ key: key as LaneKey, model, effort });
    }
    out.push(entries);
  }
  return out;
}

export const agentOf = (key: LaneKey): AgentId => key.split("-")[0] as AgentId;

/**
 * Tiers `tier`..N in order, entries in list order; per key:model only its lowest tier; a model absent from a known
 * `offered[keyId]` is dropped. Every entry applies to each account of its agent: `account` picks which one.
 */
export function candidates(tier: number, tiers: TierList, offered: Offered, account: string): Lane[] {
  const lanes: Lane[] = [];
  const seen = new Set<string>();
  for (let t = tier; t <= tiers.length; t++) {
    for (const { key, model, effort } of tiers[t - 1]) {
      const kid = keyId(key, account);
      const id = `${kid}:${model}`;
      const known = offered[kid];
      if (seen.has(id) || (known && !known.includes(model))) continue;
      seen.add(id);
      lanes.push({ id, agent: agentOf(key), account, key, tier: t, model, effort });
    }
  }
  return lanes;
}
