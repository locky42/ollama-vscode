import * as vscode from 'vscode';
import { OllamaClient, OllamaMessage } from './ollamaClient';

interface SavedChat {
    id: string;
    name: string;
    messages: OllamaMessage[];
    model: string;
    createdAt: number;
    updatedAt: number;
}

export class ChatPanel {
    public static currentPanel: ChatPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _context: vscode.ExtensionContext;
    private _disposables: vscode.Disposable[] = [];
    private _ollamaClient: OllamaClient;
    private _messages: OllamaMessage[] = [];
    private _selectedModel: string;
    private _currentRequest: { abort: () => void } | null = null;
    private _messageIdCounter: number = 0;
    private _currentChatId: string | null = null;

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._context = context;
        this._ollamaClient = new OllamaClient();
        const savedModel = context.workspaceState.get<string>('ollama.selectedModel');
        const config = vscode.workspace.getConfiguration('ollama');
        this._selectedModel = savedModel || config.get<string>('model', 'llama3.2:latest');

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(
            async (message: any) => {
                switch (message.command) {
                    case 'sendMessage':
                        await this.handleSendMessage(message.text);
                        return;
                    case 'editAndResend':
                        await this.handleEditAndResend(message.messageId, message.newText);
                        return;
                    case 'clearChat':
                        this._messages = [];
                        this._messageIdCounter = 0;
                        this._currentChatId = null;
                        this._panel.webview.postMessage({ command: 'clearChat' });
                        this.loadChatHistory();
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
                            models: models,
                            selectedModel: this._selectedModel
                        });
                        return;
                    case 'selectModel':
                        this._selectedModel = message.model;
                        this._context.workspaceState.update('ollama.selectedModel', message.model);
                        this.saveCurrentChat();
                        return;
                    case 'stopMessage':
                        if (this._currentRequest) {
                            this._currentRequest.abort();
                            this._currentRequest = null;
                        }
                        return;
                    case 'loadChat':
                        await this.loadChat(message.chatId);
                        return;
                    case 'deleteChat':
                        await this.deleteChat(message.chatId);
                        return;
                    case 'renameChat':
                        await this.renameChat(message.chatId, message.newName);
                        return;
                    case 'getChatHistory':
                        this.loadChatHistory();
                        return;
                }
            },
            null,
            this._disposables
        );

        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
        this.loadChatHistory();
    }

    private generateChatName(firstMessage: string): string {
        const maxLength = 50;
        const trimmed = firstMessage.trim();
        if (trimmed.length <= maxLength) {
            return trimmed;
        }
        return trimmed.substring(0, maxLength - 3) + '...';
    }

    private async saveCurrentChat() {
        if (this._messages.length === 0) {
            return;
        }

        const chats = this.getSavedChats();
        const now = Date.now();

        if (!this._currentChatId) {
            this._currentChatId = `chat_${now}_${Math.random().toString(36).substr(2, 9)}`;
        }

        const firstUserMessage = this._messages.find(m => m.role === 'user');
        const chatName = firstUserMessage
            ? this.generateChatName(firstUserMessage.content)
            : `Chat ${new Date(now).toLocaleString()}`;

        const savedChat: SavedChat = {
            id: this._currentChatId,
            name: chatName,
            messages: [...this._messages],
            model: this._selectedModel,
            createdAt: chats[this._currentChatId]?.createdAt || now,
            updatedAt: now
        };

        chats[this._currentChatId] = savedChat;
        await this._context.globalState.update('ollama.savedChats', chats);
        this.loadChatHistory();
    }

    private getSavedChats(): { [key: string]: SavedChat } {
        return this._context.globalState.get<{ [key: string]: SavedChat }>('ollama.savedChats', {});
    }

    private async loadChat(chatId: string) {
        const chats = this.getSavedChats();
        const chat = chats[chatId];

        if (!chat) {
            return;
        }

        this._currentChatId = chatId;
        this._messages = [...chat.messages];
        this._selectedModel = chat.model;

        let userMessageCount = 0;
        this._messages.forEach(msg => {
            if (msg.role === 'user') {
                userMessageCount++;
            }
        });
        this._messageIdCounter = userMessageCount;

        this._context.workspaceState.update('ollama.selectedModel', chat.model);

        let tempCounter = 0;
        this._panel.webview.postMessage({
            command: 'loadChatMessages',
            messages: this._messages.map((msg) => ({
                role: msg.role,
                content: msg.content,
                thinking: msg.thinking,
                id: msg.role === 'user' ? tempCounter++ : undefined
            })),
            model: chat.model
        });

        const models = await this._ollamaClient.listModels();
        this._panel.webview.postMessage({
            command: 'modelsList',
            models: models,
            selectedModel: this._selectedModel
        });
    }

    private async deleteChat(chatId: string) {
        const chats = this.getSavedChats();
        const updatedChats = { ...chats };
        delete updatedChats[chatId];
        await this._context.globalState.update('ollama.savedChats', updatedChats);

        if (this._currentChatId === chatId) {
            this._currentChatId = null;
            this._messages = [];
            this._messageIdCounter = 0;
            this._panel.webview.postMessage({ command: 'clearChat' });
        }

        this.loadChatHistory();
    }

    private async renameChat(chatId: string, newName: string) {
        if (!newName.trim()) {
            return;
        }

        const chats = this.getSavedChats();
        const chat = chats[chatId];

        if (!chat) {
            return;
        }

        chat.name = newName.trim();
        chat.updatedAt = Date.now();
        chats[chatId] = chat;

        await this._context.globalState.update('ollama.savedChats', chats);
        this.loadChatHistory();
    }

    private loadChatHistory() {
        const chats = this.getSavedChats();
        const chatList = Object.values(chats)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map(chat => ({
                id: chat.id,
                name: chat.name,
                updatedAt: chat.updatedAt
            }));

        this._panel.webview.postMessage({
            command: 'chatHistory',
            chats: chatList,
            currentChatId: this._currentChatId
        });
    }

    public static createOrShow(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
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

        ChatPanel.currentPanel = new ChatPanel(panel, extensionUri, context);
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

        const messageId = this._messageIdCounter++;
        const userMessage: OllamaMessage = {
            role: 'user',
            content: text,
        };

        this._messages.push(userMessage);
        this._panel.webview.postMessage({
            command: 'addMessage',
            message: { id: messageId, role: 'user', content: text },
        });

        await this.sendAssistantResponse();
        await this.saveCurrentChat();
    }

    private async handleEditAndResend(messageId: number, newText: string) {
        if (!newText.trim()) {
            return;
        }

        if (this._currentRequest) {
            this._currentRequest.abort();
            this._currentRequest = null;
        }

        let userMessageIndex = -1;
        let currentUserMessageId = 0;

        for (let i = 0; i < this._messages.length; i++) {
            if (this._messages[i].role === 'user') {
                if (currentUserMessageId === messageId) {
                    userMessageIndex = i;
                    break;
                }
                currentUserMessageId++;
            }
        }

        if (userMessageIndex === -1) {
            return;
        }

        this._messages[userMessageIndex].content = newText;
        this._messages = this._messages.slice(0, userMessageIndex + 1);

        this._panel.webview.postMessage({
            command: 'editMessage',
            messageId: messageId,
            newContent: newText,
        });

        this._panel.webview.postMessage({
            command: 'removeMessagesAfter',
            messageId: messageId,
        });

        await this.sendAssistantResponse();
        await this.saveCurrentChat();
    }

    private async sendAssistantResponse() {
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
            let fullThinking = '';
            const request = this._ollamaClient.chat(this._messages, this._selectedModel, (chunk) => {
                fullResponse += chunk;
                this._panel.webview.postMessage({
                    command: 'updateMessage',
                    content: fullResponse,
                });
            }, (thinking) => {
                fullThinking = thinking;
                this._panel.webview.postMessage({
                    command: 'updateThinking',
                    thinking: fullThinking,
                });
            });

            this._currentRequest = request;

            const result = await request.promise;

            this._currentRequest = null;
            assistantMessage.content = result.content;
            if (result.thinking) {
                assistantMessage.thinking = result.thinking;
            }
            const lastIndex = this._messages.length - 1;
            if (this._messages[lastIndex]?.role === 'assistant') {
                this._messages[lastIndex] = assistantMessage;
            } else {
                this._messages.push(assistantMessage);
            }
            await this.saveCurrentChat();
        } catch (error: any) {
            this._currentRequest = null;
            const errorMessage = error.message || 'An error occurred';
            if (errorMessage.includes('destroyed') || errorMessage.includes('aborted')) {
                this._panel.webview.postMessage({
                    command: 'messageStopped'
                });
            } else {
                this._panel.webview.postMessage({
                    command: 'error',
                    message: errorMessage,
                });
            }
        }
    }


    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ollama Chat</title>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js"></script>
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
            flex-direction: row;
            overflow: hidden;
        }

        .main-container {
            display: flex;
            flex-direction: column;
            flex: 1;
            overflow: hidden;
        }

        .chat-sidebar {
            width: 250px;
            border-right: 1px solid var(--vscode-panel-border);
            display: flex;
            flex-direction: column;
            background-color: var(--vscode-sideBar-background);
            overflow: hidden;
        }

        .sidebar-header {
            padding: 10px 15px;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-weight: 600;
        }

        .chat-list {
            flex: 1;
            overflow-y: auto;
            padding: 5px;
        }

        .chat-item {
            padding: 8px 10px;
            margin: 2px 0;
            border-radius: 4px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 5px;
            position: relative;
        }

        .chat-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .chat-item.active {
            background-color: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }

        .chat-item-name {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 13px;
        }

        .context-menu {
            position: fixed;
            background-color: var(--vscode-menu-background);
            border: 1px solid var(--vscode-menu-border);
            border-radius: 4px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            z-index: 1000;
            min-width: 120px;
            display: none;
        }

        .context-menu-item {
            padding: 8px 12px;
            cursor: pointer;
            font-size: 13px;
            color: var(--vscode-menu-foreground);
            user-select: none;
        }

        .context-menu-item:hover {
            background-color: var(--vscode-menu-selectionBackground);
            color: var(--vscode-menu-selectionForeground);
        }

        .context-menu-item:first-child {
            border-top-left-radius: 4px;
            border-top-right-radius: 4px;
        }

        .context-menu-item:last-child {
            border-bottom-left-radius: 4px;
            border-bottom-right-radius: 4px;
        }

        .header {
            padding: 10px 15px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 10px;
        }

        .header-left {
            display: flex;
            align-items: center;
            gap: 10px;
            flex: 1;
        }

        .model-selector {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .model-selector select {
            padding: 10px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 4px;
            font-family: inherit;
            font-size: inherit;
            height: 40px;
            box-sizing: border-box;
        }

        .model-selector select:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
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

        .new-chat-button {
            padding: 6px 12px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 600;
            font-family: inherit;
            transition: background-color 0.2s;
        }

        .new-chat-button:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
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
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
        }

        .message-actions {
            display: flex;
            gap: 4px;
            opacity: 0;
            transition: opacity 0.2s;
        }

        .message.user:hover .message-actions {
            opacity: 1;
        }

        .edit-button {
            background: none;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            padding: 2px 6px;
            font-size: 11px;
            border-radius: 3px;
            opacity: 0.7;
        }

        .edit-button:hover {
            opacity: 1;
            background-color: var(--vscode-button-hoverBackground);
        }

        .message.editing .message-content {
            padding: 0;
        }

        .message-edit-textarea {
            width: 100%;
            padding: 10px 15px;
            border: 1px solid var(--vscode-focusBorder);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 8px;
            font-family: inherit;
            font-size: inherit;
            resize: none;
            min-height: 60px;
            box-sizing: border-box;
        }

        .message-edit-textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }

        .edit-actions {
            display: flex;
            gap: 8px;
            margin-top: 8px;
            justify-content: flex-end;
        }

        .edit-actions button {
            padding: 6px 12px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 600;
        }

        .edit-save {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .edit-save:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .edit-cancel {
            background-color: transparent;
            color: var(--vscode-foreground);
            opacity: 0.7;
        }

        .edit-cancel:hover {
            opacity: 1;
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .message-content {
            padding: 10px 15px;
            border-radius: 8px;
            line-height: 1.5;
            word-wrap: break-word;
        }

        .message-content h1,
        .message-content h2,
        .message-content h3,
        .message-content h4,
        .message-content h5,
        .message-content h6 {
            margin-top: 1em;
            margin-bottom: 0.5em;
            font-weight: 600;
        }

        .message-content h1 { font-size: 1.5em; }
        .message-content h2 { font-size: 1.3em; }
        .message-content h3 { font-size: 1.1em; }

        .message-content p {
            margin: 0.5em 0;
        }

        .message-content ul,
        .message-content ol {
            margin: 0.5em 0;
            padding-left: 1.5em;
        }

        .message-content li {
            margin: 0.25em 0;
        }

        .message-content code {
            background-color: var(--vscode-textCodeBlock-background);
            color: var(--vscode-textPreformat-foreground);
            padding: 2px 4px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
            font-size: 0.9em;
        }

        .message-content pre {
            background-color: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 12px;
            overflow-x: auto;
            margin: 0.5em 0;
        }

        .message-content pre code {
            background-color: transparent;
            padding: 0;
            display: block;
            white-space: pre;
        }

        .message-content blockquote {
            border-left: 3px solid var(--vscode-panel-border);
            padding-left: 1em;
            margin: 0.5em 0;
            color: var(--vscode-descriptionForeground);
        }

        .message-content table {
            border-collapse: collapse;
            margin: 0.5em 0;
            width: 100%;
        }

        .message-content table th,
        .message-content table td {
            border: 1px solid var(--vscode-panel-border);
            padding: 6px 12px;
            text-align: left;
        }

        .message-content table th {
            background-color: var(--vscode-textCodeBlock-background);
            font-weight: 600;
        }

        .message-content a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
        }

        .message-content a:hover {
            text-decoration: underline;
        }

        .message-content hr {
            border: none;
            border-top: 1px solid var(--vscode-panel-border);
            margin: 1em 0;
        }

        .message.user .message-content {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .message.assistant .message-content {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
        }

        .thinking-section {
            margin-bottom: 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 10px;
        }

        .thinking-header {
            display: flex;
            align-items: center;
            gap: 8px;
            cursor: pointer;
            user-select: none;
            padding: 6px 0;
            font-size: 11px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            transition: color 0.2s;
        }

        .thinking-header.shimmer span:last-child {
            background: linear-gradient(
                90deg,
                var(--vscode-descriptionForeground) 0%,
                var(--vscode-foreground) 25%,
                var(--vscode-descriptionForeground) 50%,
                var(--vscode-foreground) 75%,
                var(--vscode-descriptionForeground) 100%
            );
            background-size: 200% 100%;
            background-clip: text;
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            animation: shimmer 2s linear infinite;
            display: inline-block;
        }

        @keyframes shimmer {
            0% {
                background-position: 200% 0;
            }
            100% {
                background-position: -200% 0;
            }
        }

        .thinking-header:hover {
            color: var(--vscode-foreground);
        }

        .thinking-icon {
            width: 14px;
            height: 14px;
            display: inline-block;
            transition: transform 0.2s;
        }

        .thinking-header.collapsed .thinking-icon {
            transform: rotate(-90deg);
        }

        .thinking-content {
            margin-top: 8px;
            padding: 12px;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            font-size: 12px;
            line-height: 1.6;
            color: var(--vscode-descriptionForeground);
            font-family: var(--vscode-editor-font-family);
            white-space: pre-wrap;
            word-wrap: break-word;
            max-height: 400px;
            overflow-y: auto;
            display: block;
        }

        .thinking-content.collapsed {
            display: none;
        }

        .thinking-content::-webkit-scrollbar {
            width: 8px;
        }

        .thinking-content::-webkit-scrollbar-track {
            background: transparent;
        }

        .thinking-content::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background);
            border-radius: 4px;
        }

        .thinking-content::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground);
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
            height: 40px;
            max-height: 150px;
            box-sizing: border-box;
            overflow-y: auto;
        }

        .input-container textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }

        .input-container button {
            padding: 0;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-weight: 600;
            height: 40px;
            width: 40px;
            display: flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
        }
        
        .input-container button .button-icon {
            width: 16px;
            height: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .input-container button .button-text {
            display: none;
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
    <div class="chat-sidebar">
        <div class="sidebar-header">Chat History</div>
        <div class="chat-list" id="chatList"></div>
        <div class="context-menu" id="contextMenu">
            <div class="context-menu-item" id="renameMenuItem">Rename</div>
            <div class="context-menu-item" id="deleteMenuItem">Delete</div>
        </div>
    </div>
    <div class="main-container">
        <div class="header">
            <div class="header-left">
                <h3>Ollama Chat</h3>
                <button id="newChatButton" class="new-chat-button" title="New Chat">New Chat</button>
            </div>
            <span id="status" class="status disconnected">Disconnected</span>
        </div>
        <div class="chat-container" id="chatContainer">
            <div class="empty-state">Start chatting with Ollama...</div>
        </div>
        <div class="input-container">
        <textarea id="messageInput" placeholder="Type your message..." rows="1"></textarea>
        <div class="model-selector">
            <select id="modelSelect">
                <option value="">Loading...</option>
            </select>
        </div>
        <button id="sendButton">
            <span class="button-icon" id="sendIcon">▶</span>
            <span class="button-text">Send</span>
        </button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const chatContainer = document.getElementById('chatContainer');
        const messageInput = document.getElementById('messageInput');
        const sendButton = document.getElementById('sendButton');
        const sendIcon = document.getElementById('sendIcon');
        const status = document.getElementById('status');
        const modelSelect = document.getElementById('modelSelect');
        const newChatButton = document.getElementById('newChatButton');
        const chatList = document.getElementById('chatList');
        const contextMenu = document.getElementById('contextMenu');
        const renameMenuItem = document.getElementById('renameMenuItem');
        const deleteMenuItem = document.getElementById('deleteMenuItem');
        let isLoading = false;
        let userMessageIdCounter = 0;
        let currentChatId = null;
        let contextMenuChatId = null;
        let contextMenuChatName = null;

        function renderMarkdown(content) {
            if (!content) return '';
            const html = marked.parse(content);
            return DOMPurify.sanitize(html);
        }

        function updateStatus(connected) {
            if (connected) {
                status.textContent = 'Connected';
                status.className = 'status connected';
            } else {
                status.textContent = 'Disconnected';
                status.className = 'status disconnected';
            }
        }

        function addMessage(role, content, messageId, thinking) {
            const emptyState = chatContainer.querySelector('.empty-state');
            if (emptyState) {
                emptyState.remove();
            }

            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${role}\`;
            if (role === 'user' && messageId !== undefined) {
                messageDiv.dataset.messageId = messageId;
            }
            
            const header = document.createElement('div');
            header.className = 'message-header';
            
            const headerText = document.createElement('span');
            headerText.textContent = role === 'user' ? 'You' : 'Ollama';
            header.appendChild(headerText);
            
            if (role === 'user') {
                const actions = document.createElement('div');
                actions.className = 'message-actions';
                
                const editButton = document.createElement('button');
                editButton.className = 'edit-button';
                editButton.textContent = 'Edit';
                editButton.title = 'Edit message';
                editButton.addEventListener('click', () => {
                    editUserMessage(messageDiv);
                });
                
                actions.appendChild(editButton);
                header.appendChild(actions);
            }
            
            messageDiv.appendChild(header);
            
            if (role === 'assistant') {
                const thinkingSection = document.createElement('div');
                thinkingSection.className = 'thinking-section';
                thinkingSection.style.display = 'none';
                
                const thinkingHeader = document.createElement('div');
                thinkingHeader.className = 'thinking-header collapsed';
                thinkingHeader.innerHTML = '<span class="thinking-icon">▼</span><span>Thinking</span>';
                
                const thinkingContent = document.createElement('div');
                thinkingContent.className = 'thinking-content collapsed';
                thinkingContent.textContent = '';
                
                thinkingHeader.addEventListener('click', () => {
                    const isCollapsed = thinkingHeader.classList.contains('collapsed');
                    if (isCollapsed) {
                        thinkingHeader.classList.remove('collapsed');
                        thinkingContent.classList.remove('collapsed');
                    } else {
                        thinkingHeader.classList.add('collapsed');
                        thinkingContent.classList.add('collapsed');
                    }
                });
                
                thinkingSection.appendChild(thinkingHeader);
                thinkingSection.appendChild(thinkingContent);
                messageDiv.appendChild(thinkingSection);
                messageDiv._thinkingSection = thinkingSection;
                messageDiv._thinkingContent = thinkingContent;
                
                if (thinking && thinking.trim()) {
                    thinkingContent.textContent = thinking;
                    thinkingSection.style.display = 'block';
                }
            }
            
            const contentDiv = document.createElement('div');
            contentDiv.className = 'message-content';
            if (role === 'assistant') {
                contentDiv.innerHTML = renderMarkdown(content);
            } else {
                contentDiv.textContent = content;
            }
            
            messageDiv.appendChild(contentDiv);
            
            chatContainer.appendChild(messageDiv);
            
            chatContainer.scrollTop = chatContainer.scrollHeight;
            return contentDiv;
        }

        function editUserMessage(messageDiv) {
            if (messageDiv.classList.contains('editing')) {
                return;
            }

            const messageId = parseInt(messageDiv.dataset.messageId);
            const contentDiv = messageDiv.querySelector('.message-content');
            const originalText = contentDiv.textContent;

            messageDiv.classList.add('editing');
            
            const textarea = document.createElement('textarea');
            textarea.className = 'message-edit-textarea';
            textarea.value = originalText;
            textarea.rows = Math.max(3, originalText.split('\\n').length);
            
            const editActions = document.createElement('div');
            editActions.className = 'edit-actions';
            
            const saveButton = document.createElement('button');
            saveButton.className = 'edit-save';
            saveButton.textContent = 'Save & Resend';
            saveButton.addEventListener('click', () => {
                const newText = textarea.value.trim();
                if (newText && newText !== originalText) {
                    vscode.postMessage({
                        command: 'editAndResend',
                        messageId: messageId,
                        newText: newText
                    });
                }
                cancelEdit(messageDiv, originalText);
            });
            
            const cancelButton = document.createElement('button');
            cancelButton.className = 'edit-cancel';
            cancelButton.textContent = 'Cancel';
            cancelButton.addEventListener('click', () => {
                cancelEdit(messageDiv, originalText);
            });
            
            editActions.appendChild(saveButton);
            editActions.appendChild(cancelButton);
            
            contentDiv.replaceWith(textarea);
            messageDiv.appendChild(editActions);
            
            textarea.focus();
            textarea.setSelectionRange(textarea.value.length, textarea.value.length);
            
            textarea.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    cancelEdit(messageDiv, originalText);
                } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    saveButton.click();
                }
            });
        }

        function cancelEdit(messageDiv, originalText) {
            messageDiv.classList.remove('editing');
            const textarea = messageDiv.querySelector('.message-edit-textarea');
            const editActions = messageDiv.querySelector('.edit-actions');
            
            const contentDiv = document.createElement('div');
            contentDiv.className = 'message-content';
            contentDiv.textContent = originalText;
            
            if (textarea) textarea.remove();
            if (editActions) editActions.remove();
            
            const header = messageDiv.querySelector('.message-header');
            if (header) {
                header.insertAdjacentElement('afterend', contentDiv);
            } else {
                messageDiv.appendChild(contentDiv);
            }
        }

        function editMessage(messageId, newContent) {
            const messageDiv = chatContainer.querySelector(\`[data-message-id="\${messageId}"]\`);
            if (messageDiv) {
                const contentDiv = messageDiv.querySelector('.message-content');
                if (contentDiv) {
                    contentDiv.textContent = newContent;
                }
            }
        }

        function removeMessagesAfter(messageId) {
            const messageDiv = chatContainer.querySelector(\`[data-message-id="\${messageId}"]\`);
            if (!messageDiv) return;
            
            let removeNext = false;
            const messages = Array.from(chatContainer.querySelectorAll('.message'));
            
            messages.forEach(msg => {
                if (removeNext) {
                    msg.remove();
                } else if (msg === messageDiv) {
                    removeNext = true;
                }
            });
        }

        function updateLastMessage(content) {
            const messages = chatContainer.querySelectorAll('.message.assistant');
            if (messages.length > 0) {
                const lastMessage = messages[messages.length - 1];
                const contentDiv = lastMessage.querySelector('.message-content');
                if (contentDiv) {
                    contentDiv.innerHTML = renderMarkdown(content);
                    chatContainer.scrollTop = chatContainer.scrollHeight;
                }
            }
        }

        function updateLastThinking(thinking) {
            const messages = chatContainer.querySelectorAll('.message.assistant');
            if (messages.length > 0) {
                const lastMessage = messages[messages.length - 1];
                if (lastMessage._thinkingContent && lastMessage._thinkingSection) {
                    const thinkingHeader = lastMessage._thinkingSection.querySelector('.thinking-header');
                    if (thinking && thinking.trim()) {
                        lastMessage._thinkingContent.textContent = thinking;
                        lastMessage._thinkingSection.style.display = 'block';
                        if (thinkingHeader) {
                            thinkingHeader.classList.add('shimmer');
                        }
                    } else {
                        lastMessage._thinkingSection.style.display = 'none';
                        if (thinkingHeader) {
                            thinkingHeader.classList.remove('shimmer');
                        }
                    }
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
            messageInput.style.height = '40px';
            messageInput.style.height = Math.min(messageInput.scrollHeight, 150) + 'px';
        });

        sendButton.addEventListener('click', () => {
            if (isLoading) {
                stopMessage();
            } else {
                sendMessage();
            }
        });

        function sendMessage() {
            const text = messageInput.value.trim();
            if (!text || isLoading) {
                return;
            }

            isLoading = true;
            sendButton.disabled = false;
            messageInput.disabled = true;
            if (sendIcon) {
                sendIcon.textContent = '■';
            }

            vscode.postMessage({
                command: 'sendMessage',
                text: text
            });

            messageInput.value = '';
            messageInput.style.height = '40px';
        }
        
        function stopMessage() {
            if (!isLoading) {
                return;
            }
            
            vscode.postMessage({
                command: 'stopMessage'
            });
            
            isLoading = false;
            sendButton.disabled = false;
            messageInput.disabled = false;
            if (sendIcon) {
                sendIcon.textContent = '▶';
            }
            messageInput.focus();
        }

        window.addEventListener('message', event => {
            const message = event.data;

            switch (message.command) {
                case 'addMessage':
                    const msgId = message.message.id !== undefined ? message.message.id : (message.message.role === 'user' ? userMessageIdCounter++ : undefined);
                    addMessage(message.message.role, message.message.content, msgId, message.message.thinking);
                    if (message.message.role === 'assistant') {
                        isLoading = false;
                        sendButton.disabled = false;
                        messageInput.disabled = false;
                        if (sendIcon) {
                            sendIcon.textContent = '▶';
                        }
                        messageInput.focus();
                    }
                    break;
                case 'editMessage':
                    editMessage(message.messageId, message.newContent);
                    break;
                case 'removeMessagesAfter':
                    removeMessagesAfter(message.messageId);
                    break;
                case 'updateMessage':
                    updateLastMessage(message.content);
                    break;
                case 'updateThinking':
                    updateLastThinking(message.thinking);
                    break;
                case 'error':
                    showError(message.message);
                    isLoading = false;
                    sendButton.disabled = false;
                    messageInput.disabled = false;
                    if (sendIcon) {
                        sendIcon.textContent = '▶';
                    }
                    messageInput.focus();
                    break;
                case 'connectionStatus':
                    updateStatus(message.connected);
                    break;
                case 'clearChat':
                    chatContainer.innerHTML = '<div class="empty-state">Start chatting with Ollama...</div>';
                    userMessageIdCounter = 0;
                    currentChatId = null;
                    break;
                case 'messageStopped':
                    isLoading = false;
                    sendButton.disabled = false;
                    messageInput.disabled = false;
                    if (sendIcon) {
                        sendIcon.textContent = '▶';
                    }
                    messageInput.focus();
                    break;
                case 'modelsList':
                    if (modelSelect) {
                        modelSelect.innerHTML = '';
                        if (message.models && message.models.length > 0) {
                            message.models.forEach(model => {
                                const option = document.createElement('option');
                                option.value = model;
                                option.textContent = model;
                                if (model === message.selectedModel) {
                                    option.selected = true;
                                }
                                modelSelect.appendChild(option);
                            });
                        } else {
                            const option = document.createElement('option');
                            option.value = '';
                            option.textContent = 'No models installed';
                            modelSelect.appendChild(option);
                        }
                    }
                    break;
                case 'chatHistory':
                    renderChatHistory(message.chats || [], message.currentChatId);
                    break;
                case 'loadChatMessages':
                    chatContainer.innerHTML = '';
                    userMessageIdCounter = 0;
                    if (message.messages && message.messages.length > 0) {
                        message.messages.forEach(msg => {
                            const msgId = msg.id !== undefined ? msg.id : (msg.role === 'user' ? userMessageIdCounter++ : undefined);
                            addMessage(msg.role, msg.content, msgId, msg.thinking);
                        });
                    } else {
                        chatContainer.innerHTML = '<div class="empty-state">Start chatting with Ollama...</div>';
                    }
                    if (message.model && modelSelect) {
                        const options = Array.from(modelSelect.options);
                        options.forEach(opt => {
                            if (opt.value === message.model) {
                                opt.selected = true;
                            }
                        });
                    }
                    break;
            }
        });

        function loadModels() {
            vscode.postMessage({ command: 'getModels' });
        }

        modelSelect.addEventListener('change', (e) => {
            const selectedModel = e.target.value;
            if (selectedModel) {
                vscode.postMessage({
                    command: 'selectModel',
                    model: selectedModel
                });
            }
        });

        function renderChatHistory(chats, activeChatId) {
            if (!chatList) return;
            
            chatList.innerHTML = '';
            currentChatId = activeChatId;
            
            if (chats.length === 0) {
                const emptyMsg = document.createElement('div');
                emptyMsg.style.padding = '10px';
                emptyMsg.style.color = 'var(--vscode-descriptionForeground)';
                emptyMsg.style.fontSize = '12px';
                emptyMsg.textContent = 'No saved chats';
                chatList.appendChild(emptyMsg);
                return;
            }
            
            chats.forEach(chat => {
                const chatItem = document.createElement('div');
                chatItem.className = 'chat-item';
                if (chat.id === activeChatId) {
                    chatItem.classList.add('active');
                }
                
                const nameSpan = document.createElement('span');
                nameSpan.className = 'chat-item-name';
                nameSpan.textContent = chat.name;
                nameSpan.title = chat.name;
                
                chatItem.appendChild(nameSpan);
                
                chatItem.addEventListener('click', () => {
                    if (chat.id !== activeChatId) {
                        vscode.postMessage({
                            command: 'loadChat',
                            chatId: chat.id
                        });
                    }
                });
                
                chatItem.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    showContextMenu(e, chat.id, chat.name);
                });
                
                chatList.appendChild(chatItem);
            });
        }

        function showContextMenu(event, chatId, chatName) {
            if (!contextMenu) return;
            
            contextMenuChatId = chatId;
            contextMenuChatName = chatName;
            
            contextMenu.style.display = 'block';
            contextMenu.style.left = event.clientX + 'px';
            contextMenu.style.top = event.clientY + 'px';
            
            const hideMenu = () => {
                if (contextMenu) {
                    contextMenu.style.display = 'none';
                }
                document.removeEventListener('click', hideMenu);
            };
            
            setTimeout(() => {
                document.addEventListener('click', hideMenu);
            }, 0);
        }

        if (renameMenuItem) {
            renameMenuItem.addEventListener('click', (e) => {
                e.stopPropagation();
                if (contextMenuChatId && contextMenuChatName) {
                    renameChat(contextMenuChatId, contextMenuChatName);
                }
                if (contextMenu) {
                    contextMenu.style.display = 'none';
                }
            });
        }

        if (deleteMenuItem) {
            deleteMenuItem.addEventListener('click', (e) => {
                e.stopPropagation();
                if (contextMenuChatId) {
                    if (confirm('Delete this chat?')) {
                        vscode.postMessage({
                            command: 'deleteChat',
                            chatId: contextMenuChatId
                        });
                    }
                }
                if (contextMenu) {
                    contextMenu.style.display = 'none';
                }
            });
        }
        
        function renameChat(chatId, currentName) {
            const newName = prompt('Enter new chat name:', currentName);
            if (newName && newName.trim() && newName.trim() !== currentName) {
                vscode.postMessage({
                    command: 'renameChat',
                    chatId: chatId,
                    newName: newName.trim()
                });
            }
        }

        if (newChatButton) {
            newChatButton.addEventListener('click', () => {
                vscode.postMessage({ command: 'clearChat' });
            });
        }

        vscode.postMessage({ command: 'checkConnection' });
        vscode.postMessage({ command: 'getChatHistory' });
        loadModels();
        setInterval(() => {
            vscode.postMessage({ command: 'checkConnection' });
        }, 5000);
    </script>
</body>
</html>`;
    }
}
