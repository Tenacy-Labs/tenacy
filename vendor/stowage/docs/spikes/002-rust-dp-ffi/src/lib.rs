use std::os::raw::c_int;

fn expected_dp_bytes(n_groups: usize, capacity: usize) -> u64 {
    let width = capacity as u64 + 1;
    (width * 4 * 2) + (n_groups as u64 * width)
}

fn dp_core(
    flat_w: *const c_int,
    flat_p: *const c_int,
    group_start: *const c_int,
    n_groups: c_int,
    capacity: c_int,
    out: *mut c_int,           // [value, weight, cells_visited]
    out_choices: *mut c_int,   // n_groups slots, caller-owned
    budget_mib: u64,           // back-pointer budget in MiB
) -> c_int {                   // 0 ok, -1 over-budget, -2 no-solution
    let n = n_groups as usize;
    let cap = capacity as usize;
    let width = cap + 1;
    let total = unsafe { *group_start.add(n) } as usize;
    let flat_w = unsafe { std::slice::from_raw_parts(flat_w, total) };
    let flat_p = unsafe { std::slice::from_raw_parts(flat_p, total) };
    let gs = unsafe { std::slice::from_raw_parts(group_start, n + 1) };

    if expected_dp_bytes(n, cap) > budget_mib * 1024 * 1024 {
        return -1;
    }

    let mut prev: Vec<i32> = vec![-1; width];
    let mut cur: Vec<i32> = vec![-1; width];
    let mut bp: Vec<u8> = vec![255; n * width];
    let mut cells: i64 = 0;

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

    // g0 seeding: strict >, first writer wins (mirrors dp-soa.ts)
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
        cells += 1;
    }
    let mut window_lo = g0_min;
    let mut window_hi = g0_max;

    for gi in 1..n {
        let g_min = group_min[gi];
        let g_max = group_max[gi];
        let lo = std::cmp::min(cap as i32, window_lo + g_min);
        let hi = std::cmp::min(cap as i32, window_hi + g_max);
        let s0 = gs[gi] as usize;
        let s1 = gs[gi + 1] as usize;
        for w in lo..=hi {
            let mut best = -1;
            let mut best_opt: i32 = -1;
            for i in s0..s1 {
                let pw = w - flat_w[i];
                if pw < 0 { continue; }
                let pv = prev[pw as usize];
                if pv < 0 { continue; }
                let v = pv + flat_p[i];
                cells += 1;
                if v > best { best = v; best_opt = (i - s0) as i32; }
            }
            if best >= 0 {
                cur[w as usize] = best;
                bp[gi * width + w as usize] = best_opt as u8;
            }
        }
        window_lo += g_min;
        window_hi = hi;
        std::mem::swap(&mut prev, &mut cur);
        cur.fill(-1);
    }

    let mut best_val = -1;
    let mut best_w: i32 = -1;
    for w in 0..=cap {
        if prev[w] > best_val { best_val = prev[w]; best_w = w as i32; }
    }
    if best_val < 0 {
        return -2;
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
        *out.add(2) = cells as c_int;
        for gi in 0..n {
            *out_choices.add(gi) = choices[gi];
        }
    }
    let _ = &mut bp;
    0
}

#[no_mangle]
pub extern "C" fn solve_dp_soa(
    flat_w: *const c_int, flat_p: *const c_int, group_start: *const c_int,
    n_groups: c_int, capacity: c_int, out: *mut c_int, out_choices: *mut c_int,
) -> c_int {
    dp_core(flat_w, flat_p, group_start, n_groups, capacity, out, out_choices, 50)
}

/// Budget-free variant: the back-pointer table may exceed 50 MiB — the
/// caller owns the memory decision. This is the regime TS cannot reach.
#[no_mangle]
pub extern "C" fn solve_dp_unbounded(
    flat_w: *const c_int, flat_p: *const c_int, group_start: *const c_int,
    n_groups: c_int, capacity: c_int, out: *mut c_int, out_choices: *mut c_int,
) -> c_int {
    dp_core(flat_w, flat_p, group_start, n_groups, capacity, out, out_choices, u64::MAX / (1024 * 1024))
}
