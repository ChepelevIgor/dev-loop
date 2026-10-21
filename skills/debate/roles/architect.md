---
role: architect
weight: {state: 1.4, network: 1.3, security: 1.0, ui: 0.7, perf: 1.0, algo: 0.9, default: 1.0}
---
# Architecture
Assess module boundaries, dependency direction, reversibility and maintenance cost.
- Which option will be easier to reverse later, and why?
- Which state invariants are introduced or affected, and where are they checked?
- How do changed imports and module fan-in/fan-out affect coupling?
Use import graphs, the actual diff, history of affected files and repository architecture decisions. Do not justify a choice solely as convention without repository evidence.
