# Security Policy

## Supported versions

The userscript installs from `main` and Tampermonkey keeps installed copies updated, so only the latest commit is supported.

## Reporting a vulnerability

Please report security problems privately:

- **Report a vulnerability** in the [Security tab](https://github.com/srnoob2570/ollama-usage-breakdown/security) (GitHub private vulnerability reporting), or
- open a [draft security advisory](https://github.com/srnoob2570/ollama-usage-breakdown/security/advisories/new).

Please don't open a public issue for something that could be exploited. Include the `@version` from the script header, your browser, and what an attacker could achieve; a proof of concept helps but is not required.

## Scope

In scope: anything that makes this script read, leak or alter data beyond what the [ollama.com/settings](https://ollama.com/settings) page already shows you, or that could harm someone installing it.

Out of scope:

- The script breaking when Ollama changes their page markup — that's a regular [issue](https://github.com/srnoob2570/ollama-usage-breakdown/issues).
- Problems in Ollama's own site or service — report those to Ollama.

## What to expect

Solo project, best effort: a reply within a few days, and a patch release for confirmed issues. Every change is scanned by CodeQL and reviewed by a human before release, but as the [README disclaimer](./README.md#disclaimer-ai-generated) says, both can be wrong — which is exactly why reports are welcome.