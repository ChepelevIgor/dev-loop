---
role: security
weight: {security: 1.8, network: 1.3, state: 1.0, default: 0.6}
---
# Security
Assess trust boundaries, storage, transport, injection, permissions and sensitive logging.
- Which data crosses a trust boundary in the changed code, and where is it validated?
- Could logs, screenshots or crash reports expose credentials or personal data?
- Describe one concrete plausible misuse scenario for the new behavior.
Use the diff, relevant configuration, platform permissions and dependency information. Tie findings to specific code and evidence; avoid generic security advice unrelated to the change.
