import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";

// Browser stores are read only after the user opts in (spec §5): only browser-login.ts may load cookies.ts, and only
// cookies.ts may touch node:sqlite or a Keychain "Safe Storage" item.
const SRC = join(import.meta.dirname, "..", "src");

async function sources(): Promise<Map<string, string>> {
  const files = (await readdir(SRC, { recursive: true })).filter((f) => f.endsWith(".ts"));
  return new Map(
    await Promise.all(files.map(async (f) => [f, await readFile(join(SRC, f), "utf8")] as const)),
  );
}

const mentioning = (src: Map<string, string>, needle: RegExp) =>
  [...src].filter(([, text]) => needle.test(text)).map(([file]) => file);

it("only browser-login.ts reaches cookies.ts, and never by a static value import", async () => {
  const src = await sources();
  assert.deepEqual(mentioning(src, /cookies\.ts"/), ["browser-login.ts"]);
  const text = src.get("browser-login.ts") ?? "";
  assert.doesNotMatch(text, /^import (?!type )[^;]*from "\.\/cookies\.ts"/m);
});

it("only cookies.ts touches node:sqlite or Safe Storage, and loads node:sqlite lazily", async () => {
  const src = await sources();
  assert.deepEqual(mentioning(src, /node:sqlite/), ["cookies.ts"]);
  assert.deepEqual(mentioning(src, /Safe Storage/), ["cookies.ts"]);
  assert.doesNotMatch(src.get("cookies.ts") ?? "", /^import [^;]*from "node:sqlite"/m);
});

it("only init.ts and cli.ts import browser-login.ts", async () => {
  assert.deepEqual(mentioning(await sources(), /browser-login\.ts"/).sort(), ["cli.ts", "init.ts"]);
});
