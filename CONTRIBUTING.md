# Contributing to Ollama Local Chat

Thanks for your interest in contributing! This document explains how to report issues, propose changes, and submit pull requests.

## Ways to contribute

- **Report bugs** using the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md)
- **Suggest features** using the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md)
- **Improve documentation** (README, comments, examples)
- **Submit pull requests** with bug fixes or new features

## Getting started

1. **Fork** the repository on GitHub
2. **Clone** your fork:
   ```bash
   git clone https://github.com/<your-username>/ollama-vscode.git
   cd ollama-vscode
   ```
3. **Install dependencies**:
   ```bash
   bun install
   ```
4. **Build**:
   ```bash
   bun run compile
   ```
5. **Run** the extension by pressing **F5** in VS Code (opens the Extension Development Host)

## Making changes

1. Create a new branch from `main`:
   ```bash
   git checkout -b fix/short-description
   ```
   Use prefixes like `fix/`, `feat/`, `docs/`, or `chore/`.
2. Make your changes. Keep them focused — one logical change per PR.
3. Test the extension manually in the Extension Development Host.
4. Commit with a clear message:
   ```bash
   git commit -m "fix: handle empty model list gracefully"
   ```
5. Push and open a pull request against `main`.

## Pull request guidelines

- Fill in the [PR template](.github/pull_request_template.md) completely
- Link the related issue with `Closes #123` when applicable
- Keep PRs small and reviewable
- Update the README if your change affects user-facing behavior
- Don't commit `node_modules`, `out/`, or local VS Code settings

## Code style

- TypeScript with the project's existing `tsconfig.json` settings
- Follow patterns already used in `src/` — match the surrounding code
- Run `bun run compile` to verify the build before submitting

## Reporting security issues

Please **don't** open a public issue for security vulnerabilities. Instead, contact the maintainer directly via GitHub.

## Code of conduct

Be respectful and constructive. We welcome contributors of all experience levels.

---

Questions? Open a [Discussion](https://github.com/maurokrekels/ollama-vscode/discussions) or a regular issue.
