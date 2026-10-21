# Validation

The automated suites cover local task state, evidence validation, report rendering, help topics, project configuration, API lookup and package contents. Tests use neutral local fixtures. The five regression cases cover first-use server state creation, stale design evidence invalidation, required screenshots for bug reproduction, matching task IDs and PNG integrity plus pixel decoding.

The package builder checks an explicit file allowlist, known credential patterns, required metadata and archive reproducibility. These checks do not prove the absence of every possible secret.

## Reproduce the checks

Use Python 3.10+ with `requirements.txt` and Node.js. Some tests start local loopback servers.

```bash
python -m unittest discover -s tests -v
node --test tests/handoff/*.test.mjs
node tests/report_ui.test.js
python tools/build_release.py --out dist --draft
```

## Limits

A full installed-model workflow combining a real mobile build, simulator interactions, independent model reviews and retesting has not been verified end to end. Native artifact publication and real issue-tracker actions are not established by simulated tool results. Private application projects and their evidence are not part of this repository.

OpenAI directory submission, publisher identity verification and approval are separate steps and have not been performed. A local archive or passing tests must not be described as a published release or directory approval.
