// Native SIMD kernel for the back-pointer DP (spike 003, productionized).
// One source for all hosts; the compiler's baseline ISA decides vector width:
//   aarch64 (arm64): NEON is part of the base ABI -> the gather loop with
//     #[target_feature(enable = "neon")] emits 128-bit NEON vectors.
//   x86_64: baseline SSE2 (guaranteed on every x86-64 CPU since 2003) ->
//     the interchanged max-plus scan auto-vectorizes without AVX assumptions.
//   other arches: same scalar loop, correct but slow. Max compatibility over
//     maximum speed; RUSTFLAGS must not add target-features.
// Mirrors vendor-knapsack src/dp-soa.ts solveDpSoa cell-for-cell: same
// recurrence, windowing, g0 seeding, tie-breaking (first writer wins,
// options in index order), and the expectedDpBytes budget gate (rc -1
// above budget, exactly like the TS kernel's throw). Back-pointer table
// is u8 (<=255 options/group, same constraint as the TS Uint8Array).
use std::ffi::c_int;

// Mirror of dp.ts expectedDpBytes: n*(C+1) + 8*(C+1) bytes.
#[inline]
fn expected_dp_bytes(n: usize, cap: usize) -> u64 {
    (n as u64) * (cap as u64 + 1) + 8 * (cap as u64 + 1)
}

// Budget default mirrors dp.ts DEFAULT_DP_BUDGET = 50 MiB.
const DEFAULT_DP_BUDGET: u64 = 50 * 1024 * 1024;

// Sentinel: i32::MIN, NOT -1 (spike-003 lesson): an unreachable prev cell
// must yield a value that can never beat a legit cell (>= 0) and can never
// be selected by the best-scan (init -1). -1 + profit >= 0 was reachable
// and produced bogus profit from unreachable states.
const SENT: i32 = i32::MIN;

#[cfg(target_arch = "aarch64")]
#[target_feature(enable = "neon")]
#[inline]
unsafe fn gather_max(
    cur: *mut i32, prev: *const i32, bp: *mut u8, bp_base: usize,
    w_start: usize, w_end: usize, sh: usize, pi: i32, oi: u8,
) {
    let mut w = w_start;
    while w < w_end {
        let v = *prev.add(w - sh) + pi;
        if v > *cur.add(w) {
            *cur.add(w) = v;
            *bp.add(bp_base + w) = oi;
        }
        w += 1;
    }
}

// Non-aarch64 hosts: identical loop, no target_feature attribute. On
// x86_64 the compiler auto-vectorizes at the SSE2 baseline; elsewhere it
// stays scalar. Same semantics either way (strict >, first writer wins).
#[cfg(not(target_arch = "aarch64"))]
#[inline]
unsafe fn gather_max(
    cur: *mut i32, prev: *const i32, bp: *mut u8, bp_base: usize,
    w_start: usize, w_end: usize, sh: usize, pi: i32, oi: u8,
) {
    let mut w = w_start;
    while w < w_end {
        let v = *prev.add(w - sh) + pi;
        if v > *cur.add(w) {
            *cur.add(w) = v;
            *bp.add(bp_base + w) = oi;
        }
        w += 1;
    }
}

#[no_mangle]
pub extern "C" fn knapsack_dp(
    flat_w: *const c_int, flat_p: *const c_int, group_start: *const c_int,
    n_groups: c_int, capacity: c_int, out: *mut c_int, out_choices: *mut c_int,
) -> c_int {
    // Panic containment (PR4 review): a panic escaping a cdylib aborts the
    // host process. Unwind (Cargo default) + catch_unwind at the FFI edge
    // maps any residual panic to rc -4 -> loader returns null -> caller
    // falls back to the TypeScript kernel.
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        unsafe { knapsack_dp_inner(flat_w, flat_p, group_start, n_groups, capacity, out, out_choices) }
    }));
    r.unwrap_or(-4)
}

unsafe fn knapsack_dp_inner(
    flat_w: *const c_int, flat_p: *const c_int, group_start: *const c_int,
    n_groups: c_int, capacity: c_int, out: *mut c_int, out_choices: *mut c_int,
) -> c_int {
    // Scalar guards first (PR4 review C1): negative counts/capacity can only
    // come from direct FFI misuse; rc -3 = invalid input.
    if n_groups < 0 || capacity < 0 {
        return -3;
    }
    let n = n_groups as usize;
    let cap = capacity as usize;
    let width = cap + 1;
    // Budget gate FIRST (mirrors solveDpSoa's throw-before-allocate): rc -1
    // = over budget, caller falls back to the TS path. The 50 MiB constant
    // is a BACKSTOP: the TS loader (src/native.ts) enforces the caller's
    // resolved maxDpBytes before invoking; the C ABI carries no byte-sized
    // parameter, so per-call budgets are enforced on the TS side only.
    if expected_dp_bytes(n, cap) > DEFAULT_DP_BUDGET {
        return -1;
    }
    let total = unsafe { *group_start.add(n) } as usize;
    let flat_w = unsafe { std::slice::from_raw_parts(flat_w, total) };
    let flat_p = unsafe { std::slice::from_raw_parts(flat_p, total) };
    let gs = unsafe { std::slice::from_raw_parts(group_start, n + 1) };

    // Input validation (PR4 review C1): the TS loader range-guards before
    // the Int32Array flatten, but this is also a public C symbol — defend
    // in depth. Weights must be non-negative (a negative would sign-extend
    // to a huge usize index in the g0-seed/gather paths); profits
    // non-negative (oracle semantics: best scan initializes at -1);
    // group_start strictly increasing from 0. rc -3 -> loader falls back.
    if gs[0] != 0 {
        return -3;
    }
    for i in 1..=n {
        if gs[i] < gs[i - 1] {
            return -3;
        }
    }
    for i in 0..total {
        if flat_w[i] < 0 || flat_p[i] < 0 {
            return -3;
        }
    }

    let mut prev: Vec<i32> = vec![SENT; width];
    let mut cur: Vec<i32> = vec![SENT; width];
    let mut bp: Vec<u8> = vec![0u8; n * width];

    // Per-group min/max option weights (SoA phase 0), same as dp-soa.ts.
    let mut group_min: Vec<i32> = vec![0; n];
    let mut group_max: Vec<i32> = vec![0; n];
    for gi in 0..n {
        let mut mn = i32::MAX;
        let mut mx = i32::MIN;
        for i in gs[gi]..gs[gi + 1] {
            let w = flat_w[i as usize];
            if w < mn { mn = w; }
            if w > mx { mx = w; }
        }
        group_min[gi] = mn;
        group_max[gi] = mx;
    }

    // g0 seeding (first writer wins, options in index order).
    let g0s = gs[0] as usize;
    let g0e = gs[1] as usize;
    let mut g0_min = flat_w[g0s];
    let mut g0_max = flat_w[g0s];
    for i in g0s..g0e {
        let w = flat_w[i];
        if w < g0_min { g0_min = w; }
        if w > g0_max { g0_max = w; }
        if w <= cap as i32 && flat_p[i] > prev[w as usize] {
            prev[w as usize] = flat_p[i];
            bp[w as usize] = (i - g0s) as u8;
        }
    }
    let mut window_lo = g0_min;
    let mut window_hi = g0_max;

    for gi in 1..n {
        let g_min = group_min[gi];
        let lo = std::cmp::min(cap as i32, window_lo + g_min);
        let hi = std::cmp::min(cap as i32, window_hi + group_max[gi]);
        let s0 = gs[gi] as usize;
        let s1 = gs[gi + 1] as usize;
        for i in s0..s1 {
            let wi = flat_w[i];
            let pi = flat_p[i];
            let oi = (i - s0) as u8;
            if wi > hi { continue; }
            let start = std::cmp::max(lo, wi) as usize;
            unsafe {
                gather_max(
                    cur.as_mut_ptr(), prev.as_ptr(), bp.as_mut_ptr(),
                    gi * width, start, hi as usize + 1, wi as usize, pi, oi,
                );
            }
        }
        window_lo += g_min;
        window_hi = hi;
        std::mem::swap(&mut prev, &mut cur);
        cur.fill(SENT);
    }

    let mut best_val = -1;
    let mut best_w: i32 = -1;
    for w in 0..=cap {
        if prev[w] > best_val { best_val = prev[w]; best_w = w as i32; }
    }
    if best_val < 0 {
        return -2; // no feasible solution
    }
    let mut choices: Vec<i32> = vec![-1; n];
    let mut w = best_w;
    for gi in (1..n).rev() {
        let opt_idx = bp[gi * width + w as usize] as i32;
        choices[gi] = opt_idx;
        w -= flat_w[gs[gi] as usize + opt_idx as usize];
    }
    choices[0] = bp[w as usize] as i32;
    unsafe {
        *out.add(0) = best_val;
        *out.add(1) = best_w;
        for gi in 0..n { *out_choices.add(gi) = choices[gi]; }
    }
    0
}
