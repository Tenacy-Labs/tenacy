# Memory-R1: RL for Memory Management

- **Link:** https://arxiv.org/abs/2508.19828
- **Repo:** https://github.com/yansikuan/memory-r1
- **Related formalization: utility objective for memory policies:** https://arxiv.org/abs/2603.11768
- **Kind:** Paper + OSS
- **Date:** 2025-08
- **Relates to:** ADR-0003 §4 (refit pipeline)

Trains the memory manager itself: ADD/UPDATE/DELETE/NOOP as policy actions under PPO with long-horizon rewards, plus a separate answer agent, on LoCoMo. The learning-loop cousin of our offline refit: where Memory-R1 learns memory ops by gradient descent on task reward, we refit forecast parameters (μ₀, α, hazards) from the decision corpus by statistical estimation — review-gated, versioned, prior-guarded. Their reward-shaping troubles are our self-conditioning risk wearing different clothes.
