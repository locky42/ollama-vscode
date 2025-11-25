import * as vscode from 'vscode';
import { OllamaClient, OllamaMessage } from './ollamaClient';

export class ChatPanel {
    public static currentPanel: ChatPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _ollamaClient: OllamaClient;
    private _messages: OllamaMessage[] = [];

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._ollamaClient = new OllamaClient();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(
            async (message: any) => {
                switch (message.command) {
                    case 'sendMessage':
                        await this.handleSendMessage(message.text);
                        return;
                    case 'clearChat':
                        this._messages = [];
                        this._panel.webview.postMessage({ command: 'clearChat' });
                        return;
                    case 'checkConnection':
                        const isConnected = await this._ollamaClient.checkConnection();
                        this._panel.webview.postMessage({
                            command: 'connectionStatus',
                            connected: isConnected
                        });
                        return;
                    case 'getModels':
                        const models = await this._ollamaClient.listModels();
                        this._panel.webview.postMessage({
                            command: 'modelsList',
                            models: models
                        });
                        return;
                }
            },
            null,
            this._disposables
        );

        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
    }

    public static createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ChatPanel.currentPanel) {
            ChatPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'ollamaChat',
            'Ollama Chat',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
            }
        );

        ChatPanel.currentPanel = new ChatPanel(panel, extensionUri);
    }

    public dispose() {
        ChatPanel.currentPanel = undefined;

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private async handleSendMessage(text: string) {
        if (!text.trim()) {
            return;
        }

        const userMessage: OllamaMessage = {
            role: 'user',
            content: text,
        };

        this._messages.push(userMessage);
        this._panel.webview.postMessage({
            command: 'addMessage',
            message: { role: 'user', content: text },
        });

        const assistantMessage: OllamaMessage = {
            role: 'assistant',
            content: '',
        };

        this._panel.webview.postMessage({
            command: 'addMessage',
            message: { role: 'assistant', content: '' },
        });

        try {
            let fullResponse = '';
            await this._ollamaClient.chat(this._messages, (chunk) => {
                fullResponse += chunk;
                this._panel.webview.postMessage({
                    command: 'updateMessage',
                    content: fullResponse,
                });
            });

            assistantMessage.content = fullResponse;
            const lastIndex = this._messages.length - 1;
            if (this._messages[lastIndex]?.role === 'assistant') {
                this._messages[lastIndex] = assistantMessage;
            } else {
                this._messages.push(assistantMessage);
            }
        } catch (error: any) {
            const errorMessage = error.message || 'An error occurred';
            this._panel.webview.postMessage({
                command: 'error',
                message: errorMessage,
            });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ollama Chat</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }

        .header {
            padding: 10px 15px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .status {
            font-size: 12px;
            padding: 4px 8px;
            border-radius: 4px;
            background-color: var(--vscode-badge-background);
        }

        .status.connected {
            background-color: #4caf50;
            color: white;
        }

        .status.disconnected {
            background-color: #f44336;
            color: white;
        }

        .chat-container {
            flex: 1;
            overflow-y: auto;
            padding: 15px;
            display: flex;
            flex-direction: column;
            gap: 15px;
        }

        .message {
            display: flex;
            flex-direction: column;
            max-width: 80%;
            animation: fadeIn 0.3s;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .message.user {
            align-self: flex-end;
        }

        .message.assistant {
            align-self: flex-start;
        }

        .message-header {
            font-size: 11px;
            opacity: 0.7;
            margin-bottom: 5px;
            font-weight: 600;
        }

        .message-content {
            padding: 10px 15px;
            border-radius: 8px;
            line-height: 1.5;
            word-wrap: break-word;
        }

        .message.user .message-content {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .message.assistant .message-content {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
        }

        .input-container {
            padding: 15px;
            border-top: 1px solid var(--vscode-panel-border);
            display: flex;
            gap: 10px;
        }

        .input-container textarea {
            flex: 1;
            padding: 10px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 4px;
            font-family: inherit;
            font-size: inherit;
            resize: none;
            min-height: 40px;
            max-height: 150px;
        }

        .input-container textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }

        .input-container button {
            padding: 10px 20px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-weight: 600;
        }

        .input-container button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .input-container button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .error {
            padding: 10px;
            margin: 10px;
            background-color: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            border-radius: 4px;
            color: var(--vscode-errorForeground);
        }

        .empty-state {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--vscode-descriptionForeground);
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="header">
        <h3>Ollama Chat</h3>
        <span id="status" class="status disconnected">Disconnected</span>
    </div>
    <div class="chat-container" id="chatContainer">
        <div class="empty-state">Start chatting with Ollama...</div>
    </div>
    <div class="input-container">
        <textarea id="messageInput" placeholder="Type your message..." rows="1"></textarea>
        <button id="sendButton">Send</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const chatContainer = document.getElementById('chatContainer');
        const messageInput = document.getElementById('messageInput');
        const sendButton = document.getElementById('sendButton');
        const status = document.getElementById('status');
        let isLoading = false;

        function updateStatus(connected) {
            if (connected) {
                status.textContent = 'Connected';
                status.className = 'status connected';
            } else {
                status.textContent = 'Disconnected';
                status.className = 'status disconnected';
            }
        }

        function addMessage(role, content) {
            const emptyState = chatContainer.querySelector('.empty-state');
            if (emptyState) {
                emptyState.remove();
            }

            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${role}\`;
            
            const header = document.createElement('div');
            header.className = 'message-header';
            header.textContent = role === 'user' ? 'You' : 'Ollama';
            
            const contentDiv = document.createElement('div');
            contentDiv.className = 'message-content';
            contentDiv.textContent = content;
            
            messageDiv.appendChild(header);
            messageDiv.appendChild(contentDiv);
            chatContainer.appendChild(messageDiv);
            
            chatContainer.scrollTop = chatContainer.scrollHeight;
            return contentDiv;
        }

        function updateLastMessage(content) {
            const messages = chatContainer.querySelectorAll('.message.assistant');
            if (messages.length > 0) {
                const lastMessage = messages[messages.length - 1];
                const contentDiv = lastMessage.querySelector('.message-content');
                if (contentDiv) {
                    contentDiv.textContent = content;
                    chatContainer.scrollTop = chatContainer.scrollHeight;
                }
            }
        }

        function showError(message) {
            const errorDiv = document.createElement('div');
            errorDiv.className = 'error';
            errorDiv.textContent = message;
            chatContainer.appendChild(errorDiv);
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }

        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        messageInput.addEventListener('input', () => {
            messageInput.style.height = 'auto';
            messageInput.style.height = messageInput.scrollHeight + 'px';
        });

        sendButton.addEventListener('click', sendMessage);

        function sendMessage() {
            const text = messageInput.value.trim();
            if (!text || isLoading) {
                return;
            }

            isLoading = true;
            sendButton.disabled = true;
            messageInput.disabled = true;

            vscode.postMessage({
                command: 'sendMessage',
                text: text
            });

            messageInput.value = '';
            messageInput.style.height = 'auto';
        }

        window.addEventListener('message', event => {
            const message = event.data;

            switch (message.command) {
                case 'addMessage':
                    addMessage(message.message.role, message.message.content);
                    if (message.message.role === 'assistant') {
                        isLoading = false;
                        sendButton.disabled = false;
                        messageInput.disabled = false;
                        messageInput.focus();
                    }
                    break;
                case 'updateMessage':
                    updateLastMessage(message.content);
                    break;
                case 'error':
                    showError(message.message);
                    isLoading = false;
                    sendButton.disabled = false;
                    messageInput.disabled = false;
                    messageInput.focus();
                    break;
                case 'connectionStatus':
                    updateStatus(message.connected);
                    break;
                case 'clearChat':
                    chatContainer.innerHTML = '<div class="empty-state">Start chatting with Ollama...</div>';
                    break;
            }
        });

        vscode.postMessage({ command: 'checkConnection' });
        setInterval(() => {
            vscode.postMessage({ command: 'checkConnection' });
        }, 5000);
    </script>
</body>
</html>`;
    }
}
