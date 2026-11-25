// Regenerates assets/demo.gif from scene.html: node assets/demo/render.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FPS = 20;
const here = dirname(fileURLToPath(import.meta.url));

// Playwright lives in a temp dir so it never enters the schmear package.
const deps = join(tmpdir(), "schmear-demo-deps");
if (!existsSync(join(deps, "node_modules", "playwright"))) {
  execFileSync("npm", ["install", "--prefix", deps, "--no-audit", "--no-fund", "playwright@1.65.1"], { stdio: "inherit" });
  execFileSync(join(deps, "node_modules", ".bin", "playwright"), ["install", "chromium-headless-shell"], { stdio: "inherit" });
}
const { chromium } = createRequire(join(deps, "package.json"))("playwright");

const frames = mkdtempSync(join(tmpdir(), "schmear-demo-frames-"));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 }, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(join(here, "scene.html")).href);
  const count = (await page.evaluate("DURATION")) * FPS;
  const paths = [];
  for (let i = 0; i < count; i++) {
    await page.evaluate((t) => render(t), i / FPS);
    paths.push(join(frames, `${String(i).padStart(4, "0")}.png`));
    await page.screenshot({ path: paths[i] });
  }
  execFileSync("gifski", ["--fps", String(FPS), "--width", "1200", "--quality", "100", "--quiet", "-o", join(here, "..", "demo.gif"), ...paths], { stdio: "inherit" });
} finally {
  await browser.close();
  rmSync(frames, { recursive: true });
}
