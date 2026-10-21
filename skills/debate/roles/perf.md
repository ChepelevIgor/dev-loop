---
role: perf
weight: {perf: 1.6, algo: 1.2, state: 0.9, network: 1.1, default: 0.8}
---
# Performance
Assess complexity, allocation, main-thread work, networking and energy use.
- State changed-path complexity and what n represents in actual datasets.
- Identify main-thread work against the relevant frame budget using measurements.
- Consider an access-appropriate index, set, ring buffer or incremental update when supported by the workload.
Use repository benchmarks, profiles and measured timings. Screen settling time can suggest animation issues but is not a CPU profile. Do not predict slowness without a measurement or a defensible complexity argument.
