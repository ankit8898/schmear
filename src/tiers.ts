import {
  agentOf,
  type Entry,
  isCreditKey,
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
    "gemini-credits:gemini-4-hydrogen@high",
  ],
  [
    "claude:sonnet@medium",
    "codex:gpt-6.1-terra@medium",
    "agy-gemini:gemini-4-hydrogen@medium",
    "agy-argon:gemini-4-argon@medium",
    "agy-3p:claude-sonnet-5-5@medium",
    "claude-credits:sonnet@medium",
    "gemini-credits:gemini-4-hydrogen@high",
  ],
  [
    "claude:opus@medium",
    "codex:gpt-6.1-terra@max",
    "agy-gemini:gemini-4-hydrogen@high",
    "agy-argon:gemini-4-argon@medium",
    "agy-3p:claude-opus-5-5@medium",
    "claude-credits:opus@medium",
    "gemini-credits:gemini-4-hydrogen@high",
  ],
  [
    "claude:fable@medium",
    "codex:gpt-6.2-sol@xhigh",
    "agy-gemini:gemini-4-carbon@medium",
    "claude-credits:fable@medium",
    "gemini-credits:gemini-4-carbon@high",
  ],
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

/**
 * The agy subscription key whose quota group a model spends ("Gemini 4 Argon", "Claude and GPT models", "Gemini
 * Models"; docs/research/model-tiers.md): all three keys offer every model, so the offered list cannot tell.
 */
const agyKeyOf = (model: string): LaneKey =>
  model === "gemini-4-argon"
    ? "agy-argon"
    : model.startsWith("claude-") || model.startsWith("gpt-")
      ? "agy-3p"
      : "agy-gemini";

/**
 * A task pinned to `model@effort` (§6): one lane per key of `keys`, in `LANE_KEYS` order, whose key lists the model
 * in some tier or is the model's own key (`agyKeyOf` for agy's subscription keys; every other key is its agent's
 * only one); a known offered list without the model drops the key. Each lane carries the task's `tier`.
 */
export function pinned(
  tier: number,
  model: string,
  effort: string,
  tiers: TierList,
  offered: Offered,
  account: string,
  keys: readonly LaneKey[],
): Lane[] {
  return LANE_KEYS.filter((key) => keys.includes(key)).flatMap((key) => {
    const kid = keyId(key, account);
    const known = offered[kid];
    const entry = tiers.flat().some((e) => e.key === key && e.model === model);
    const own = agentOf(key) !== "agy" || isCreditKey(key) || agyKeyOf(model) === key;
    const listed = known ? known.includes(model) && (entry || own) : entry;
    return listed ? [{ id: `${kid}:${model}`, agent: agentOf(key), account, key, tier, model, effort }] : [];
  });
}
