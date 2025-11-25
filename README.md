# Ollama VS Code Extension

Een VS Code extensie om te chatten met Ollama lokaal, vergelijkbaar met GitHub Copilot maar dan met je eigen lokale Ollama instance.

## Features

- 💬 Chat interface in VS Code
- 🔌 Automatische verbinding met lokale Ollama instance
- ⚡ Streaming responses voor real-time antwoorden
- 🎨 Moderne UI die past bij VS Code thema's
- ⚙️ Configureerbare model selectie

## Vereisten

- [Ollama](https://ollama.ai/) moet lokaal geïnstalleerd en draaiend zijn
- VS Code versie 1.74.0 of hoger

## Installatie

1. Clone deze repository
2. Open de folder in VS Code
3. Installeer dependencies: `npm install`
4. Compileer de extensie: `npm run compile`
5. Druk op F5 om de extensie te testen in een nieuwe VS Code window

## Gebruik

1. Zorg dat Ollama lokaal draait (`ollama serve`)
2. Open de command palette (Cmd+Shift+P / Ctrl+Shift+P)
3. Typ "Open Ollama Chat" en selecteer de command
4. Start met chatten!

## Configuratie

Je kunt de volgende instellingen aanpassen in VS Code settings:

- `ollama.baseUrl`: De URL van je Ollama API (standaard: `http://localhost:11434`)
- `ollama.model`: Het standaard model om te gebruiken (standaard: `llama2`)

## Development

```bash
npm install
npm run compile
npm run watch
```

Druk op F5 in VS Code om de extensie te testen.

## License

MIT
