# Security review

Reviewed on October 25, 2026. This is a source review and dependency audit, not a guarantee that every vulnerability has been found.

## Changes made

| Finding | Change |
| --- | --- |
| Privileged IPC handlers did not authenticate the calling frame. | Every handler now requires the current app window's main frame and the exact bundled document URL. |
| Engine subprocesses inherited desktop credentials, provider endpoint overrides, tracing configuration, and Python import hooks. | The engine receives an allowlist of operating-system variables plus explicitly selected app credentials and settings. |
| Installer publisher verification accepted any certificate subject containing `ollama`. | Require a valid Authenticode signature and an exact allowed publisher name. A publisher name change fails closed until reviewed. |
| Installer downloads used a predictable shared temporary path and did not reliably handle stream errors. | Use a unique directory, exclusive file creation, a stream pipeline, and cleanup on success or failure. |
| Spreadsheet account names could resolve inherited object properties. | Account dictionaries have null prototypes, including when merging positions. |
| External links could contain credentials or alternate ports, and browser launch errors were unhandled. | Reject those URL forms and await the external browser operation. |
| The installed private engine contained vulnerable pip 25.0.1. | Updated that environment to pip 26.2.2; setup requires pip 26.2 or later before installing engine packages. |

The existing sandbox, context isolation, disabled renderer Node integration, restrictive CSP, text-based model rendering, blocked navigation/new windows, and OS-encrypted API-key storage remain enabled. Permission checks also explicitly deny requests.

IPC restrictions follow [Electron's security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

## Verification

- `npm test`: 77 passing logic, process, component-installation, renderer-logic, and security regression tests.
- `npm run test:py`: 21 passing tests for briefing validation and market/calendar commands with deterministic data.
- Chromium UI harness: 229 checks passed, zero failed. It exercised real app handlers and the installed engine with a fake model and deterministic external-feed fixtures, including import, analyses, queues, cancellation, backtests, link/path safety, and responsive layouts. The in-process browser driver explicitly bypasses Electron frame authentication; the dedicated IPC security tests separately exercise the sender guard.
- Live `npm audit`: zero known vulnerabilities in the lockfile (419 dependencies reported).
- `pip-audit` examined 89 installed engine package records. After the pip update, zero known vulnerabilities were reported among auditable packages. TradingAgents 0.7.0 was skipped because it is installed from GitHub and is not present in the advisory service's PyPI package catalog.
- Source checks for common embedded credential formats found no matching production secrets. `.gitignore` excludes environment files, private-key files, installed dependencies, audit tooling, bytecode, and generated UI artifacts.

## Limits and operating assumptions

- TradingAgents is pinned to commit `e8f5503e9b86d5c2710b0c76b1f686703968c9df`. This review does not certify its complete source or all behavior of downloaded models and external services. Python transitive dependencies are resolved at installation time; audit the actual environment again after upgrades.
- Local holdings, journals, settings, and reports are ordinary files under the user profile. API keys are encrypted; the rest of the financial data is not encrypted by the app. Protect the Windows account and disk.
- Model endpoints are configurable and support HTTP for local servers. Use loopback addresses or HTTPS on a trusted server. A remote HTTP endpoint exposes prompts and holdings to network observers. Selecting a cloud provider or a remote model server sends the requested context there.
- Authenticode verification is tested with simulated signatures; a real Ollama installer was not downloaded or executed during this review. Python/Git installation, GPU behavior, live market data accuracy, and a production model were not validated.
- Windows installer packaging, code signing, and a packaged Electron security review remain release checks. The browser UI harness does not certify the packaged Electron binary.
- Keep Electron, Node dependencies, Python, engine dependencies, and Ollama patched. Advisory results describe the audit date and installed versions only.

If you find a vulnerability, contact the repository owner privately before disclosing sensitive reproduction details. Do not put API keys or real portfolio data in public issues.
