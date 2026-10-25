/** Stop awaiting a provider without letting its late result reach AgentLoop. */
export function untilCancelled<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new Error("ACP prompt cancelled"));
    signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve().then(call).then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", cancel));
  });
}
