// Plain JS so Node can run the identical file
const state = { turns: [], vars: new Map() };
state.vars.set("df", Array.from({ length: 1000 }, (_, i) => ({ i, v: i * 2 })));

setTimeout(() => {
  const mu = process.memoryUsage ? process.memoryUsage() : { rss: 0, heapUsed: 0 };
  console.log("kernelSim rss after 2s:", Math.round(mu.rss / 1024 / 1024), "MB, heapUsed:", Math.round(mu.heapUsed / 1024 / 1024), "MB");
}, 2000);
