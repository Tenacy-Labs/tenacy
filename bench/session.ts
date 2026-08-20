// One agent "session": a worker holding kernel state persistently.
// Responds to: "load-state", "echo" (turn dispatch), "status"
const vars = new Map();
let contextBuffer = "";

self.onmessage = (e) => {
  const msg = e.data;
  if (msg === "load-state") {
    // Representative kernel heap: ~50 variables of parsed-JSON-ish structures ≈ 1MB
    for (let i = 0; i < 50; i++) {
      vars.set(`var_${i}`, Array.from({ length: 200 }, (_, j) => ({
        id: j, name: `record_${i}_${j}`, values: [j * 1.5, j * 2.5, j * 3.5],
        tags: ["alpha", "beta", "gamma"],
      })));
    }
    // Context-buffer equivalent: ~100k tokens ≈ 400KB of text
    contextBuffer = Array.from({ length: 2000 }, (_, i) =>
      `turn ${i}: assistant analysis paragraph with plausible content ${i}`).join("\n");
    (self as any).postMessage("state-loaded");
  } else if (msg && msg.cmd === "echo") {
    (self as any).postMessage({ cmd: "reply", n: msg.n });
  } else if (msg === "status") {
    const heapKB = Math.round(JSON.stringify([...vars.keys()]).length / 1024);
    (self as any).postMessage({
      cmd: "status",
      varCount: vars.size,
      heapApproxKB: heapKB,
      ctxBufferKB: Math.round(contextBuffer.length / 1024),
    });
  }
};
(self as any).postMessage("ready");
