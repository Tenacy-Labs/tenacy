const t0 = performance.now();
let x = 0;
for (let i = 0; i < 1000; i++) { x += i; }
const t1 = performance.now();
console.log("1000 trivial ops in-process:", (t1 - t0).toFixed(3), "ms");
console.log("heapUsed:", Math.round(process.memoryUsage().heapUsed / 1024 / 1024), "MB");
