import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import process from "node:process";

export interface SelectOption {
  readonly label: string;
  readonly detail?: string;
}

export interface StartTerminal {
  readonly isInteractive: boolean;
  prompt(question: string, signal?: AbortSignal): Promise<string | null>;
  select(question: string, options: readonly SelectOption[]): Promise<number | null>;
  close?(): void;
}

export interface ProgressView {
  readonly elapsedSeconds: number;
  readonly screens: number;
  readonly states: number;
  readonly actions: number;
  readonly findings: number;
}

export class ProgressRenderer {
  #visible = false;
  readonly #interactive: boolean;
  readonly #writeLine: (text: string) => void;

  constructor(interactive: boolean, writeLine: (text: string) => void) {
    this.#interactive = interactive;
    this.#writeLine = writeLine;
  }

  update(progress: ProgressView): void {
    const minutes = Math.floor(progress.elapsedSeconds / 60);
    const seconds = progress.elapsedSeconds % 60;
    const elapsed = `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
    const line = `Elapsed ${elapsed} | Screens ${progress.screens} | States ${progress.states} | Actions ${progress.actions} | Findings ${progress.findings}`;
    if (!this.#interactive) {
      if (progress.elapsedSeconds > 0 && progress.elapsedSeconds % 10 === 0) this.#writeLine(line);
      return;
    }
    process.stdout.write(`\u001b[2K\r${line}`);
    this.#visible = true;
  }

  finish(): void {
    if (!this.#visible) return;
    process.stdout.write("\u001b[2K\r");
    this.#visible = false;
  }
}

export class ProcessStartTerminal implements StartTerminal {
  #question: ReturnType<typeof createInterface> | undefined;

  get isInteractive(): boolean {
    return Boolean(process.stdin.isTTY);
  }

  async prompt(question: string, signal?: AbortSignal): Promise<string | null> {
    this.#question ??= createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = signal === undefined
        ? await this.#question.question(`${question} `)
        : await this.#question.question(`${question} `, { signal });
      const value = answer.trim();
      return value.length === 0 ? null : value;
    } catch (error) {
      if (signal?.aborted === true || (error instanceof Error && error.name === "AbortError")) {
        return null;
      }
      throw error;
    }
  }

  select(question: string, options: readonly SelectOption[]): Promise<number | null> {
    return new Promise((resolveSelection) => {
      if (!this.isInteractive || options.length === 0) {
        resolveSelection(null);
        return;
      }
      let selected = 0;
      let finished = false;
      const input = process.stdin;
      const wasRaw = input.isRaw ?? false;
      emitKeypressEvents(input);
      if (input.setRawMode !== undefined) input.setRawMode(true);
      const finish = (value: number | null): void => {
        if (finished) return;
        finished = true;
        input.removeListener("keypress", listener);
        if (input.setRawMode !== undefined) input.setRawMode(wasRaw);
        resolveSelection(value);
      };
      const render = (): void => {
        process.stdout.write(`\u001b[2J\u001b[H${question}\n`);
        options.forEach((option, index) => {
          const pointer = index === selected ? ">" : " ";
          const detail = option.detail === undefined ? "" : ` - ${option.detail}`;
          process.stdout.write(`${pointer} ${option.label}${detail}\n`);
        });
        process.stdout.write("Use Up/Down and Enter. Escape cancels.\n");
      };
      function listener(character: string, key: { name?: string; sequence?: string; ctrl?: boolean }): void {
        if (key.ctrl && key.name === "c") {
          process.stdout.write("\n");
          finish(null);
          return;
        }
        if (key.name === "up" || key.sequence === "\u001b[A") {
          selected = (selected - 1 + options.length) % options.length;
          render();
          return;
        }
        if (key.name === "down" || key.sequence === "\u001b[B") {
          selected = (selected + 1) % options.length;
          render();
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          process.stdout.write("\n");
          finish(selected);
          return;
        }
        if (key.name === "escape") {
          process.stdout.write("\n");
          finish(null);
          return;
        }
      }
      input.addListener("keypress", listener);
      render();
    });
  }

  close(): void {
    this.#question?.close();
    this.#question = undefined;
  }
}
