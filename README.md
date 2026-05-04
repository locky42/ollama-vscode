# Ollama Local Chat

VS Code extension to chat with a local Ollama instance inside the editor—similar to Copilot-style chat but using your own models.

## Requirements

- [Ollama](https://ollama.ai/) installed and running locally
- VS Code 1.74.0 or newer

## Installation

1. Install dependencies: `bun install`
2. Build: `bun run compile`
3. Press **F5** in VS Code to run the extension in a new window (Extension Development Host)

To install from source in your main VS Code:

1. Run `bun run compile`
2. In VS Code: **Run** → **Install Additional Development Extensions...** → choose **Install from VSIX...** and pick the built VSIX, or run the extension from this folder via **Run and Debug** (F5).

## Usage

1. Start Ollama (e.g. `ollama serve` or ensure the Ollama app is running).
2. Open the Command Palette: **Cmd+Shift+P** (macOS) or **Ctrl+Shift+P** (Windows/Linux).
3. Run **Open Ollama Chat**.
4. Use the chat panel to send messages; responses stream in real time.

## Configuration

In VS Code **Settings** (or `settings.json`):

| Setting          | Description                | Default                  |
| ---------------- | -------------------------- | ------------------------ |
| `ollama.baseUrl` | Ollama API base URL        | `http://localhost:11434` |
| `ollama.model`   | Default model for the chat | `llama3.2:latest`        |

## Features

- Chat panel inside VS Code
- Connects to your local Ollama API
- Streaming responses
- Theme-aware UI
- Configurable model and base URL

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up the project, propose changes, and submit pull requests. By participating, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

- Found a bug? [Open an issue](../../issues/new?template=bug_report.md).
- Have an idea? [Request a feature](../../issues/new?template=feature_request.md).

## License

MIT
