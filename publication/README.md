# Public directory submission

Development version: 0.1.0. This folder supports the publisher and is excluded from the installable ZIP.

## Public project and pages

- Project: https://github.com/ChepelevIgor/dev-loop
- Support: https://github.com/ChepelevIgor/dev-loop/blob/main/SUPPORT.md
- Issue tracker: https://github.com/ChepelevIgor/dev-loop/issues
- Privacy notice: https://github.com/ChepelevIgor/dev-loop/blob/main/PRIVACY.md
- Publisher: https://github.com/ChepelevIgor

The publisher authorized publication of the source repository. The authorization recorded in `publisher.json` is not an assertion of OpenAI identity verification or acceptance of dashboard attestations.

## Build the submission ZIP

`plugin.json` is the portable manifest. The ZIP contains eight skills, including the help guide, their supporting scripts/references, SVG icons, the dependency list and user documentation. It has no MCP server, app registration, lifecycle hooks, source marketplace, test fixtures, credentials, Python environment or development patch. The local execution flag declares its desktop requirement.

```bash
python tools/build_release.py --out dist --ready --check-urls
```

When a release is requested, the archive is named `dist/dev-loop-<version>.zip` using the version in `plugin.json`. Use the adjacent SHA-256 file to identify the archive and the audit JSON to inspect its contents and checked public URLs. `--draft` remains available for development packages with incomplete publisher information. The builder never uploads or submits a package itself.

The local preflight checks packaging and URL reachability, not legal adequacy, account verification, independent reviewer quality or actual app behavior. See [validation evidence and limitations](VALIDATION.md). The full real-app simulator/reviewer workflow is not yet verified end to end; it must not be claimed as passed.

## Submit and publish

Use the standard skills-only ZIP flow for a desktop package. Review the imported metadata and skill findings and resolve required errors. Select the verified developer identity in the dashboard and complete the applicable ownership/policy attestations yourself. Public availability on GitHub does not publish the plugin in OpenAI's directory. Directory publication follows approval as a separate step.

A skills-only package does not require MCP review cases or an MCP demo video. If the portal rejects the local execution flag, ask OpenAI to confirm submission access for the organization. No license terms, jurisdiction, business identity or OpenAI attestations have been selected on the publisher's behalf.

Official references: [submission and manifest fields](https://developers.openai.com/plugins/deploy/submission), [desktop-only packages](https://developers.openai.com/plugins/deploy/desktop-only), [plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines).
