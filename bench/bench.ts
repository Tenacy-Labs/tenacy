// Extended benchmark: N concurrent persistent sessions in one Bun process.
const rssMB = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
const N = 10;

function spawnSession(): Promise<Worker> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const w = new Worker(new URL("./session.ts", import.meta.url), { type: "module" });
    w.onmessage = (e) => {
      if (e.data === "ready") {
        w.postMessage("load-state");
      } else if (e.data === "state-loaded") {
        (w as any)._spawnMs = Math.round((performance.now() - t0) * 10) / 10;
        resolve(w);
      }
    };
    w.onerror = (err) => reject(err);
  });
}

function turn(w: Worker, n: number): Promise<number> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    w.onmessage = (e) => {
      if (e.data && e.data.cmd === "reply") resolve(performance.now() - t0);
    };
    w.postMessage({ cmd: "echo", n });
  });
}

async function main() {
  console.log(`bun ${Bun.version} | baseline process rss: ${rssMB()} MB`);

  const workers: Worker[] = [];
  const spawnTimes: number[] = [];
  for (let i = 0; i < N; i++) {
    const before = rssMB();
    const w = await spawnSession();
    workers.push(w);
    spawnTimes.push((w as any)._spawnMs);
    await Bun.sleep(150); // let allocation settle
    const after = rssMB();
    console.log(`session ${i + 1}: spawn+init ${(w as any)._spawnMs}ms | rss ${before} -> ${after} MB (+${after - before})`);
  }

  // Status from one worker to confirm the state is really resident
  await new Promise((res) => {
    const w0 = workers[0];
    if (!w0) throw new Error("no workers");
    w0.onmessage = (e) => {
      if (e.data && e.data.cmd === "status") {
        console.log(`sample session state: ${e.data.varCount} vars (~${e.data.heapApproxKB}KB keys), ctx buffer ${e.data.ctxBufferKB}KB`);
        res(null);
      }
    };
    w0.postMessage("status");
  });

  // Turn dispatch: 200 round-trips across all 10 sessions
  const lat: number[] = [];
  for (let r = 0; r < 20; r++) {
    for (let i = 0; i < N; i++) {
      const w = workers[i];
      if (w) lat.push(await turn(w, r));
    }
  }
  lat.sort((a, b) => a - b);
  const med = lat[Math.floor(lat.length / 2)] ?? 0;
  const p95v = lat[Math.floor(lat.length * 0.95)] ?? 0;
  console.log(`turn dispatch over ${N} warm sessions: median ${(med * 1000).toFixed(0)}µs, p95 ${(p95v * 1000).toFixed(0)}µs (${lat.length} round-trips)`);

  const spawnSorted = [...spawnTimes].sort((a, b) => a - b);
  const smed = spawnSorted[Math.floor(N / 2)] ?? 0;
  console.log(`\nSUMMARY | sessions: ${N} | total rss: ${rssMB()} MB | marginal/session: ~${Math.round((rssMB() - 27) / N)} MB | spawn median: ${smed}ms`);
  process.exit(0);
}

await main();
