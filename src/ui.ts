import { spawn } from "node:child_process";
import { stripVTControlCharacters, styleText } from "node:util";
import * as p from "@clack/prompts";

export type TextStyle = Parameters<typeof styleText>[0];

/** Styles `text` only when `color` is true, independent of stdout TTY state. */
export const paint = (color: boolean, format: TextStyle, text: string): string =>
  color ? styleText(format, text, { validateStream: false }) : text;

/** Visible column width of `text`, ignoring ANSI VT escape sequences. */
export const visibleWidth = (text: string): number => stripVTControlCharacters(text).length;

export interface TextOptions {
  detail?: string;
  placeholder?: string;
  /** Prefilled answer (terminal) or the answer to an empty reply (piped). */
  initial?: string;
  /** Returns an error message for an invalid answer. */
  validate?: (value: string) => string | undefined;
}

export interface InitIO {
  readonly color: boolean;
  readonly width: number;
  start(title: string, subtitle?: string): void;
  /** Checkboxes; returns the ticked values. */
  choose(message: string, options: { value: string; label: string }[], ticked: string[]): Promise<string[]>;
  /** One choice from a list; `initial` is the preselected value (terminal) or the answer to an empty reply (piped). */
  select(
    message: string,
    options: { value: string; label: string; hint?: string }[],
    initial: string,
  ): Promise<string>;
  text(message: string, opts?: TextOptions): Promise<string>;
  /** Shows `running` while `work` runs, then the line `done` returns. `update` refreshes the live status line. */
  task<T>(
    running: string,
    work: (update: (status: string) => void) => Promise<T>,
    done: (result: T) => string,
  ): Promise<T>;
  /** Runs a child on the user's terminal and resolves its exit code; rejects if it cannot start. Terminal only. */
  run?(command: string, args: string[], env: Record<string, string>): Promise<number>;
  /** Starts a detached child and returns at once. Terminal only. */
  launch?(command: string, args: string[]): void;
  log(kind: "info" | "ok" | "warn" | "error", text: string): void;
  /** Framed summary panel (`note` in a terminal, plain lines when piped). */
  panel?(title: string, body: string): void;
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

/** Wraps at spaces to fit `width` visible columns; clack's log does not wrap. */
export function wrap(text: string, width = Math.max(40, (process.stdout.columns ?? 80) - 3)): string {
  return text
    .split("\n")
    .map((line) => {
      if (visibleWidth(line) <= width) return line;
      const indent = /^ */.exec(line)?.[0] ?? "";
      const rows = [indent];
      let rowWidth = indent.length;
      for (const word of line.slice(indent.length).split(" ")) {
        const w = visibleWidth(word);
        const row = rows[rows.length - 1] as string;
        if (rowWidth > indent.length && rowWidth + 1 + w > width) {
          rows.push(`${indent}${word}`);
          rowWidth = indent.length + w;
        } else {
          rows[rows.length - 1] = rowWidth === indent.length ? `${row}${word}` : `${row} ${word}`;
          rowWidth = rowWidth === indent.length ? rowWidth + w : rowWidth + 1 + w;
        }
      }
      return rows.join("\n");
    })
    .join("\n");
}

function styleIntro(title: string, color: boolean): string {
  const space = title.indexOf(" ");
  if (space < 0) return paint(color, ["bold", "cyan"], title);
  return `${paint(color, ["bold", "cyan"], title.slice(0, space))} ${paint(color, "dim", title.slice(space + 1))}`;
}

/** Interactive prompts for a terminal. */
export function ttyIO(): InitIO {
  // Honour NO_COLOR, FORCE_COLOR=0 and non-TTY stdout using node:util's own colour detection.
  const color = styleText("dim", "x") !== "x";
  const width = () => Math.max(40, (process.stdout.columns ?? 80) - 3);
  const symbol = {
    info: paint(color, "gray", "│"),
    ok: paint(color, "green", "✓"),
    warn: paint(color, "yellow", "▲"),
    error: paint(color, "red", "✗"),
  };
  return {
    color,
    get width() {
      return width();
    },
    start: (title, subtitle) => {
      p.intro(styleIntro(title, color));
      if (subtitle) {
        p.log.message(paint(color, "dim", wrap(subtitle, width())), { symbol: symbol.info, spacing: 0 });
      }
    },
    choose: async (message, options, ticked) =>
      exitOnCancel(await p.multiselect({ message, options, initialValues: ticked, required: false })),
    select: async (message, options, initial) =>
      exitOnCancel(await p.select({ message, options, initialValue: initial })),
    text: async (message, opts = {}) => {
      if (opts.detail) {
        p.log.message(paint(color, "dim", wrap(opts.detail, width())));
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
        const result = await work((status) => s.message(status));
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
    launch: (command, args) => {
      // The caller checked the file exists, so a spawn error has nothing to add.
      spawn(command, args, { detached: true, stdio: "ignore" })
        .on("error", () => {})
        .unref();
    },
    log: (kind, text) =>
      p.log.message(wrap(text, width()), {
        symbol: symbol[kind],
        spacing: kind === "info" && text.includes("\n") ? 1 : 0,
      }),
    panel: (title, body) => p.note(body, title),
    end: (text) => p.outro(text),
  };
}

const PREFIX = { info: "", ok: "✓ ", warn: "! ", error: "✗ " } as const;

/** Plain lines for piped input, where raw-mode prompts cannot run. `ask` prints a question and returns the reply. */
export function lineIO(ask: (question: string) => Promise<string>, out: (text: string) => void): InitIO {
  return {
    color: false,
    width: 100,
    start: (title, subtitle) => out(subtitle ? `${title} — ${subtitle}` : title),
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
      const result = await work(() => {});
      out(done(result));
      return result;
    },
    log: (kind, text) => out(`${PREFIX[kind]}${text}`),
    panel: (title, body) => out(`${title}\n${body}`),
    end: out,
  };
}
