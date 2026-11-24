import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { styleText } from "node:util";
import * as p from "@clack/prompts";

export interface TextOptions {
  detail?: string;
  placeholder?: string;
  /** Prefilled answer (terminal) or the answer to an empty reply (piped). */
  initial?: string;
  /** Returns an error message for an invalid answer. */
  validate?: (value: string) => string | undefined;
}

export interface InitIO {
  start(title: string): void;
  /** Checkboxes; returns the ticked values. */
  choose(message: string, options: { value: string; label: string }[], ticked: string[]): Promise<string[]>;
  /** One choice from a list; `initial` is the preselected value (terminal) or the answer to an empty reply (piped). */
  select(
    message: string,
    options: { value: string; label: string; hint?: string }[],
    initial: string,
  ): Promise<string>;
  text(message: string, opts?: TextOptions): Promise<string>;
  /** Shows `running` while `work` runs, then the line `done` returns. */
  task<T>(running: string, work: () => Promise<T>, done: (result: T) => string): Promise<T>;
  /** Runs a child on the user's terminal and resolves its exit code; rejects if it cannot start. Terminal only. */
  run?(command: string, args: string[], env: Record<string, string>): Promise<number>;
  /** Opens the installed menu bar or tray app, else says how to get it; returns that line. Terminal only. */
  openApp?(): string;
  log(kind: "info" | "ok" | "warn" | "error", text: string): void;
  end(text: string): void;
}

const exitOnCancel = <T>(value: T | symbol): Exclude<T, symbol> => {
  if (p.isCancel(value)) {
    p.cancel("Setup cancelled; nothing after this point was changed.");
    process.exit(130);
  }
  return value as Exclude<T, symbol>;
};

const withDetail = (message: string, detail?: string) => (detail ? `${message}\n${detail}` : message);

const SYMBOL = {
  info: styleText("gray", "│"),
  ok: styleText("green", "✓"),
  warn: styleText("yellow", "▲"),
  error: styleText("red", "✗"),
};

/** Wraps at spaces to fit after clack's 3-column gutter; clack's log does not wrap. */
function wrap(text: string): string {
  const width = Math.max(40, (process.stdout.columns ?? 80) - 3);
  return text
    .split("\n")
    .map((line) => {
      const rows = [""];
      for (const word of line.split(" ")) {
        const row = rows[rows.length - 1] as string;
        if (row !== "" && row.length + 1 + word.length > width) rows.push(word);
        else rows[rows.length - 1] = row === "" ? word : `${row} ${word}`;
      }
      return rows.join("\n");
    })
    .join("\n");
}

/** Interactive prompts for a terminal. */
/** The menu bar app (macOS) or tray app (Linux), opened detached; both hand a second launch to the running one. */
function openApp(): string {
  if (process.platform === "darwin") {
    const app = ["/Applications", join(homedir(), "Applications")]
      .map((dir) => join(dir, "Schmear.app"))
      .find((path) => existsSync(path));
    if (!app) return "Menu bar app: `brew install --cask kevin1chun/tap/schmear`.";
    spawn("open", [app], { detached: true, stdio: "ignore" }).unref();
    return "Opened the menu bar app.";
  }
  const tray = join(homedir(), ".local", "bin", "schmear-tray");
  if (!existsSync(tray)) return "Tray app: https://github.com/kevin1chun/schmear#linux-tray-app";
  spawn(tray, [], { detached: true, stdio: "ignore" }).unref();
  return "Opened the tray app.";
}

export function ttyIO(): InitIO {
  return {
    openApp,
    start: (title) => p.intro(title),
    choose: async (message, options, ticked) =>
      exitOnCancel(await p.multiselect({ message, options, initialValues: ticked, required: false })),
    select: async (message, options, initial) =>
      exitOnCancel(await p.select({ message, options, initialValue: initial })),
    text: async (message, opts = {}) => {
      if (opts.detail) {
        p.log.message(styleText("dim", wrap(opts.detail)));
      }
      return exitOnCancel(
        await p.text({
          message,
          placeholder: opts.placeholder,
          initialValue: opts.initial,
          validate: opts.validate && ((v) => opts.validate?.(v ?? "")),
        }),
      ).trim();
    },
    async task(running, work, done) {
      const s = p.spinner();
      s.start(running);
      try {
        const result = await work();
        s.stop(done(result));
        return result;
      } catch (err) {
        s.error(running);
        throw err;
      }
    },
    run: (command, args, env) =>
      new Promise((resolve, reject) => {
        // Ctrl-C belongs to the child, as with a shell's foreground job; init carries on after it exits.
        const ignore = () => {};
        process.on("SIGINT", ignore);
        spawn(command, args, { stdio: "inherit", env })
          .on("error", (err) => {
            process.off("SIGINT", ignore);
            reject(err);
          })
          .on("close", (code) => {
            process.off("SIGINT", ignore);
            resolve(code ?? 1);
          });
      }),
    log: (kind, text) => p.log.message(wrap(text), { symbol: SYMBOL[kind], spacing: 0 }),
    end: (text) => p.outro(text),
  };
}

const PREFIX = { info: "", ok: "✓ ", warn: "! ", error: "✗ " } as const;

/** Plain lines for piped input, where raw-mode prompts cannot run. `ask` prints a question and returns the reply. */
export function lineIO(ask: (question: string) => Promise<string>, out: (text: string) => void): InitIO {
  return {
    start: out,
    async choose(message, options, ticked) {
      const values = options.map((o) => o.value);
      const answer = (
        await ask(`${message} (${values.join(", ")}; comma-separated) [${ticked.join(", ")}] `)
      ).trim();
      const picked =
        answer === ""
          ? ticked
          : answer
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean);
      const unknown = picked.filter((v) => !values.includes(v));
      if (unknown.length > 0) {
        throw new Error(`invalid answer '${answer}' to: ${message} (unknown ${unknown.join(", ")})`);
      }
      return picked;
    },
    async select(message, options, initial) {
      const values = options.map((o) => o.value);
      const answer = (await ask(`${message} (${values.join(", ")}) [${initial}] `)).trim() || initial;
      if (!values.includes(answer)) {
        throw new Error(`invalid answer '${answer}' to: ${message} (unknown ${answer})`);
      }
      return answer;
    },
    async text(message, opts = {}) {
      const answer = (await ask(`${withDetail(message, opts.detail)} `)).trim() || (opts.initial ?? "");
      const invalid = opts.validate?.(answer);
      if (invalid) {
        throw new Error(`invalid answer '${answer}' to: ${message} (${invalid})`);
      }
      return answer;
    },
    async task(running, work, done) {
      out(`${running}…`);
      const result = await work();
      out(done(result));
      return result;
    },
    log: (kind, text) => out(`${PREFIX[kind]}${text}`),
    end: out,
  };
}
