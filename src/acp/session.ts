import { Worker } from "node:worker_threads";
import type { TurnOutcome } from "../optimizer/loop.ts";
import type { PromptResponse } from "@agentclientprotocol/sdk";

export type Reply = { text: string; tools: TurnOutcome["toolResults"]; stopReason: PromptResponse["stopReason"] };
export type WorkerReply = { result: Reply } | { error: string };

/** One isolate per session: AgentLoop's host bindings are process-global. */
export class Session {
  private worker: Worker;
  private pending: { resolve(value: Reply): void; reject(error: Error): void } | undefined;
  private failure: Error | undefined;

  constructor(cwd: string, provider: string, model?: string) {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
      workerData: { cwd, provider, model }, stdout: true, stderr: true,
    });
    // Providers must never write diagnostics into the ACP protocol stream.
    this.worker.stdout?.on("data", (chunk) => process.stderr.write(chunk));
    this.worker.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    this.worker.on("message", (reply: WorkerReply) => {
      const pending = this.pending;
      this.pending = undefined;
      if ("error" in reply) pending?.reject(new Error(reply.error));
      else pending?.resolve(reply.result);
    });
    this.worker.on("error", (error) => this.fail(error instanceof Error ? error : new Error(String(error))));
    this.worker.on("exit", (code) => this.fail(new Error(`Session worker exited (${code})`)));
  }

  private fail(error: Error): void {
    this.failure = error;
    this.pending?.reject(error);
    this.pending = undefined;
  }

  get busy(): boolean { return this.pending !== undefined; }

  prompt(text: string): Promise<Reply> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.busy) return Promise.reject(new Error("Session already has an active prompt"));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker.postMessage({ type: "prompt", text });
    });
  }

  cancel(): void { if (this.busy) this.worker.postMessage({ type: "cancel" }); }
  async close(): Promise<void> {
    this.fail(new Error("Connection closed"));
    await this.worker.terminate();
  }
}
