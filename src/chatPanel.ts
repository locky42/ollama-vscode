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
    private _operationLocks: Set<string> = new Set();
    private _saveTimeout: NodeJS.Timeout | null = null;
    private readonly _saveDebounceMs: number = 500;

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
                        if (this._currentChatId && this._messages.length > 0) {
                            await this.saveCurrentChat();
                        }
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
                    case 'toggleSidebar':
                        this._context.workspaceState.update('ollama.sidebarCollapsed', message.collapsed);
                        return;
                    case 'getSidebarState':
                        const sidebarCollapsed = this._context.workspaceState.get<boolean>('ollama.sidebarCollapsed', false);
                        this._panel.webview.postMessage({
                            command: 'setSidebarState',
                            collapsed: sidebarCollapsed
                        });
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

    private generateUniqueChatId(): string {
        const timestamp = Date.now().toString(36);
        const randomPart = Math.random().toString(36).substring(2, 15);
        const additionalRandom = Math.random().toString(36).substring(2, 15);
        return `chat_${timestamp}_${randomPart}_${additionalRandom}`;
    }

    private isOperationLocked(operation: string): boolean {
        return this._operationLocks.has(operation);
    }

    private lockOperation(operation: string): void {
        this._operationLocks.add(operation);
    }

    private unlockOperation(operation: string): void {
        this._operationLocks.delete(operation);
    }

    private async withOperationLock<T>(operation: string, fn: () => Promise<T>): Promise<T> {
        if (this.isOperationLocked(operation)) {
            throw new Error(`Operation '${operation}' is already in progress`);
        }

        this.lockOperation(operation);
        try {
            return await fn();
        } finally {
            this.unlockOperation(operation);
        }
    }

    private async saveCurrentChat(force: boolean = false) {
        if (this._messages.length === 0) {
            return;
        }

        if (force) {
            await this.performSave();
            return;
        }

        if (this._saveTimeout) {
            clearTimeout(this._saveTimeout);
        }

        this._saveTimeout = setTimeout(async () => {
            await this.performSave();
            this._saveTimeout = null;
        }, this._saveDebounceMs);
    }

    private async performSave() {
        try {
            const chats = this.getSavedChats();
            const now = Date.now();
            let isNewChat = false;

            if (!this._currentChatId) {
                this._currentChatId = this.generateUniqueChatId();
                isNewChat = true;
            }

            const firstUserMessage = this._messages.find(m => m.role === 'user');
            const chatName = firstUserMessage
                ? this.generateChatName(firstUserMessage.content)
                : `Chat ${new Date(now).toLocaleString()}`;

            const existingChat = chats[this._currentChatId];

            const hasChanges = !existingChat ||
                existingChat.messages.length !== this._messages.length ||
                existingChat.model !== this._selectedModel ||
                existingChat.name !== chatName ||
                JSON.stringify(existingChat.messages) !== JSON.stringify(this._messages);

            if (!isNewChat && !hasChanges) {
                return;
            }

            const savedChat: SavedChat = {
                id: this._currentChatId,
                name: chatName,
                messages: [...this._messages],
                model: this._selectedModel,
                createdAt: existingChat?.createdAt || now,
                updatedAt: now
            };

            chats[this._currentChatId] = savedChat;
            await this._context.globalState.update('ollama.savedChats', chats);

            if (isNewChat) {
                this.loadChatHistory();
            }
        } catch (error) {
            console.error('Failed to save chat:', error);
        }
    }

    private getSavedChats(): { [key: string]: SavedChat } {
        return this._context.globalState.get<{ [key: string]: SavedChat }>('ollama.savedChats', {});
    }

    private async loadChat(chatId: string) {
        const chats = this.getSavedChats();
        const chat = chats[chatId];

        if (!chat) {
            this._panel.webview.postMessage({
                command: 'error',
                message: 'Chat not found'
            });
            return;
        }

        this._currentChatId = chatId;
        this._messages = [...chat.messages];
        this._selectedModel = chat.model;

        this._messageIdCounter = this._messages
            .filter(msg => msg.role === 'user')
            .length;

        this._context.workspaceState.update('ollama.selectedModel', chat.model);

        const messagesWithIds = this._messages.map((msg, index) => {
            const messageId = msg.role === 'user' ? index : undefined;
            return {
                role: msg.role,
                content: msg.content,
                thinking: msg.thinking,
                id: messageId
            };
        });

        this._panel.webview.postMessage({
            command: 'loadChatMessages',
            messages: messagesWithIds,
            model: chat.model,
            nextMessageId: this._messageIdCounter
        });

        const models = await this._ollamaClient.listModels();
        this._panel.webview.postMessage({
            command: 'modelsList',
            models: models,
            selectedModel: this._selectedModel
        });
    }

    private async deleteChat(chatId: string) {
        if (!chatId || typeof chatId !== 'string' || chatId.trim() === '') {
            this._panel.webview.postMessage({
                command: 'error',
                message: 'Invalid chat ID provided'
            });
            return;
        }

        const operationKey = `delete_${chatId}`;

        try {
            await this.withOperationLock(operationKey, async () => {
                const chats = this.getSavedChats();

                if (!chats[chatId]) {
                    this._panel.webview.postMessage({
                        command: 'error',
                        message: 'Chat not found or already deleted'
                    });
                    await this.refreshChatHistory();
                    return;
                }

                const wasCurrentChat = this._currentChatId === chatId;

                const updatedChats = { ...chats };
                delete updatedChats[chatId];

                await this._context.globalState.update('ollama.savedChats', updatedChats);

                if (wasCurrentChat) {
                    this._currentChatId = null;
                    this._messages = [];
                    this._messageIdCounter = 0;
                    this._panel.webview.postMessage({ command: 'clearChat' });
                }

                await this.refreshChatHistory();

                this._panel.webview.postMessage({
                    command: 'chatDeleted',
                    chatId: chatId,
                    wasCurrentChat: wasCurrentChat
                });
            });
        } catch (error: any) {
            if (error.message?.includes('already in progress')) {
                this._panel.webview.postMessage({
                    command: 'error',
                    message: 'Delete operation is already in progress for this chat. Please wait and try again.'
                });
                return;
            }

            console.error('Error deleting chat:', error);
            const errorMessage = error?.message || 'An unexpected error occurred while deleting the chat';
            this._panel.webview.postMessage({
                command: 'error',
                message: `Failed to delete chat: ${errorMessage}`
            });

            try {
                await this.refreshChatHistory();
            } catch (refreshError) {
                console.error('Failed to refresh chat history after delete error:', refreshError);
            }
        }
    }

    private async renameChat(chatId: string, newName: string) {
        if (!chatId || typeof chatId !== 'string' || chatId.trim() === '') {
            this._panel.webview.postMessage({
                command: 'error',
                message: 'Invalid chat ID provided'
            });
            return;
        }

        const trimmedName = newName?.trim();
        if (!trimmedName || trimmedName.length === 0) {
            this._panel.webview.postMessage({
                command: 'error',
                message: 'Chat name cannot be empty'
            });
            return;
        }

        if (trimmedName.length > 100) {
            this._panel.webview.postMessage({
                command: 'error',
                message: 'Chat name is too long (maximum 100 characters allowed)'
            });
            return;
        }

        const operationKey = `rename_${chatId}`;

        try {
            await this.withOperationLock(operationKey, async () => {
                const chats = this.getSavedChats();
                const chat = chats[chatId];

                if (!chat) {
                    this._panel.webview.postMessage({
                        command: 'error',
                        message: 'Chat not found or may have been deleted'
                    });
                    await this.refreshChatHistory();
                    return;
                }

                if (chat.name === trimmedName) {
                    return;
                }

                const updatedChat = {
                    ...chat,
                    name: trimmedName,
                    updatedAt: Date.now()
                };

                const updatedChats = {
                    ...chats,
                    [chatId]: updatedChat
                };

                await this._context.globalState.update('ollama.savedChats', updatedChats);

                await this.refreshChatHistory();

                this._panel.webview.postMessage({
                    command: 'chatRenamed',
                    chatId: chatId,
                    newName: trimmedName
                });
            });
        } catch (error: any) {
            if (error.message?.includes('already in progress')) {
                this._panel.webview.postMessage({
                    command: 'error',
                    message: 'Rename operation is already in progress for this chat. Please wait and try again.'
                });
                return;
            }

            console.error('Error renaming chat:', error);
            const errorMessage = error?.message || 'An unexpected error occurred while renaming the chat';
            this._panel.webview.postMessage({
                command: 'error',
                message: `Failed to rename chat: ${errorMessage}`
            });

            try {
                await this.refreshChatHistory();
            } catch (refreshError) {
                console.error('Failed to refresh chat history after rename error:', refreshError);
            }
        }
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

    private async refreshChatHistory() {
        await new Promise(resolve => setTimeout(resolve, 50));
        this.loadChatHistory();
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

        if (this._saveTimeout) {
            clearTimeout(this._saveTimeout);
            this._saveTimeout = null;
        }

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
            transition: width 0.3s ease;
        }

        .chat-sidebar.collapsed {
            width: 0;
            border-right: none;
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

        .modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 2000;
        }

        .modal-content {
            background-color: var(--vscode-quickInput-background);
            border: 1px solid var(--vscode-quickInput-border);
            border-radius: 6px;
            padding: 20px;
            min-width: 400px;
            max-width: 500px;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
        }

        .modal-header {
            font-size: 16px;
            font-weight: 600;
            margin-bottom: 16px;
            color: var(--vscode-quickInput-foreground);
        }

        .modal-input {
            width: 100%;
            padding: 8px 12px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 3px;
            font-family: inherit;
            font-size: 13px;
            box-sizing: border-box;
        }

        .modal-input:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }

        .modal-actions {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
            margin-top: 16px;
        }

        .modal-button {
            padding: 6px 12px;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            font-family: inherit;
        }

        .modal-button.primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .modal-button.primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .modal-button.secondary {
            background-color: transparent;
            color: var(--vscode-foreground);
        }

        .modal-button.secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .header {
            padding: 10px 15px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 10px;
        }

        .sidebar-toggle {
            background: none;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            padding: 6px;
            border-radius: 3px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            opacity: 0.7;
            transition: opacity 0.2s;
        }

        .sidebar-toggle:hover {
            opacity: 1;
            background-color: var(--vscode-toolbar-hoverBackground);
        }

        .sidebar-toggle.collapsed {
            transform: rotate(180deg);
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
    <div class="chat-sidebar" id="chatSidebar">
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
                <button id="sidebarToggle" class="sidebar-toggle" title="Toggle Sidebar">
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-left-icon lucide-chevron-left"><path d="m15 18-6-6 6-6"/></svg>
                </button>
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
        const sidebarToggle = document.getElementById('sidebarToggle');
        const chatSidebar = document.getElementById('chatSidebar');
        const chatList = document.getElementById('chatList');
        const contextMenu = document.getElementById('contextMenu');
        const renameMenuItem = document.getElementById('renameMenuItem');
        const deleteMenuItem = document.getElementById('deleteMenuItem');
        let isLoading = false;
        let userMessageIdCounter = 0;
        let currentChatId = null;
        let contextMenuChatId = null;
        let contextMenuChatName = null;
        let isOperationInProgress = false;
        let pendingOperations = new Set();
        let sidebarCollapsed = false;

        function toggleSidebar() {
            sidebarCollapsed = !sidebarCollapsed;
            if (chatSidebar) {
                if (sidebarCollapsed) {
                    chatSidebar.classList.add('collapsed');
                } else {
                    chatSidebar.classList.remove('collapsed');
                }
            }
            if (sidebarToggle) {
                if (sidebarCollapsed) {
                    sidebarToggle.classList.add('collapsed');
                    sidebarToggle.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-right-icon lucide-chevron-right"><path d="m9 18 6-6-6-6"/></svg>';
                } else {
                    sidebarToggle.classList.remove('collapsed');
                    sidebarToggle.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-left-icon lucide-chevron-left"><path d="m15 18-6-6 6-6"/></svg>';
                }
            }
            vscode.postMessage({
                command: 'toggleSidebar',
                collapsed: sidebarCollapsed
            });
        }

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
                    if (contextMenuChatId && pendingOperations.has(contextMenuChatId)) {
                        pendingOperations.delete(contextMenuChatId);
                    }
                    if (pendingOperations.size === 0) {
                        isOperationInProgress = false;
                        contextMenuChatId = null;
                        contextMenuChatName = null;
                    }
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
                    if (isOperationInProgress && message.chats) {
                        const chatExists = message.chats.some(chat => chat.id === contextMenuChatId);
                        if (!chatExists && pendingOperations.has(contextMenuChatId)) {
                            pendingOperations.delete(contextMenuChatId);
                            if (pendingOperations.size === 0) {
                                isOperationInProgress = false;
                                contextMenuChatId = null;
                                contextMenuChatName = null;
                            }
                        }
                    }
                    break;
                case 'loadChatMessages':
                    chatContainer.innerHTML = '';
                    userMessageIdCounter = message.nextMessageId || 0;
                    if (message.messages && message.messages.length > 0) {
                        message.messages.forEach(msg => {
                            addMessage(msg.role, msg.content, msg.id, msg.thinking);
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
                case 'chatDeleted':
                    if (pendingOperations.has(message.chatId)) {
                        pendingOperations.delete(message.chatId);
                    }
                    if (pendingOperations.size === 0) {
                        isOperationInProgress = false;
                        contextMenuChatId = null;
                        contextMenuChatName = null;
                    }
                    if (message.wasCurrentChat) {
                        currentChatId = null;
                    }
                    break;
                case 'chatRenamed':
                    if (pendingOperations.has(message.chatId)) {
                        pendingOperations.delete(message.chatId);
                    }
                    if (pendingOperations.size === 0) {
                        isOperationInProgress = false;
                        contextMenuChatId = null;
                        contextMenuChatName = null;
                    }
                    break;
                case 'setSidebarState':
                    sidebarCollapsed = message.collapsed;
                    if (sidebarCollapsed) {
                        chatSidebar.classList.add('collapsed');
                        sidebarToggle.classList.add('collapsed');
                        sidebarToggle.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-right-icon lucide-chevron-right"><path d="m9 18 6-6-6-6"/></svg>';
                    } else {
                        chatSidebar.classList.remove('collapsed');
                        sidebarToggle.classList.remove('collapsed');
                        sidebarToggle.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-left-icon lucide-chevron-left"><path d="m15 18-6-6 6-6"/></svg>';
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
            if (!contextMenu || isOperationInProgress || pendingOperations.has(chatId)) {
                return;
            }
            
            contextMenuChatId = chatId;
            contextMenuChatName = chatName;
            
            contextMenu.style.display = 'block';
            contextMenu.style.left = event.clientX + 'px';
            contextMenu.style.top = event.clientY + 'px';
            
            const hideMenu = (e) => {
                if (contextMenu && !contextMenu.contains(e.target)) {
                    contextMenu.style.display = 'none';
                    document.removeEventListener('click', hideMenu);
                }
            };
            
            setTimeout(() => {
                document.addEventListener('click', hideMenu);
            }, 0);
        }

        if (renameMenuItem) {
            renameMenuItem.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                const chatId = contextMenuChatId;
                const chatName = contextMenuChatName;
                
                if (!chatId || !chatName || isOperationInProgress || pendingOperations.has(chatId)) {
                    if (contextMenu) {
                        contextMenu.style.display = 'none';
                    }
                    return;
                }
                
                if (contextMenu) {
                    contextMenu.style.display = 'none';
                }
                
                renameChat(chatId, chatName);
            });
        }

        if (deleteMenuItem) {
            deleteMenuItem.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                const chatId = contextMenuChatId;
                
                if (!chatId || isOperationInProgress || pendingOperations.has(chatId)) {
                    if (contextMenu) {
                        contextMenu.style.display = 'none';
                    }
                    return;
                }
                
                if (contextMenu) {
                    contextMenu.style.display = 'none';
                }
                
                deleteChat(chatId);
            });
        }
        
        function renameChat(chatId, currentName) {
            showRenameDialog(chatId, currentName);
        }
        
        function deleteChat(chatId) {
            const chatName = contextMenuChatName;
            showDeleteDialog(chatId, chatName);
        }

        if (newChatButton) {
            newChatButton.addEventListener('click', () => {
                vscode.postMessage({ command: 'clearChat' });
            });
        }

        if (sidebarToggle) {
            sidebarToggle.addEventListener('click', () => {
                toggleSidebar();
            });
        }

        vscode.postMessage({ command: 'checkConnection' });
        vscode.postMessage({ command: 'getSidebarState' });
        vscode.postMessage({ command: 'getChatHistory' });
        loadModels();
        setInterval(() => {
            vscode.postMessage({ command: 'checkConnection' });
        }, 5000);

        // Modal dialog functions
        function showRenameDialog(chatId, currentName) {
            if (isOperationInProgress || pendingOperations.has(chatId)) {
                return;
            }

            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';

            const content = document.createElement('div');
            content.className = 'modal-content';

            const header = document.createElement('div');
            header.className = 'modal-header';
            header.textContent = 'Rename Chat';

            const input = document.createElement('input');
            input.className = 'modal-input';
            input.type = 'text';
            input.value = currentName;
            input.maxLength = 100;

            const actions = document.createElement('div');
            actions.className = 'modal-actions';

            const cancelButton = document.createElement('button');
            cancelButton.className = 'modal-button secondary';
            cancelButton.textContent = 'Cancel';
            cancelButton.onclick = function() {
                document.body.removeChild(overlay);
            };

            const saveButton = document.createElement('button');
            saveButton.className = 'modal-button primary';
            saveButton.textContent = 'Rename';
            saveButton.onclick = function() {
                const newName = input.value.trim();
                if (!newName) {
                    showError('Chat name cannot be empty');
                    return;
                }

                if (newName === currentName) {
                    document.body.removeChild(overlay);
                    return;
                }

                if (newName.length > 100) {
                    showError('Chat name is too long (max 100 characters)');
                    return;
                }

                isOperationInProgress = true;
                pendingOperations.add(chatId);

                vscode.postMessage({
                    command: 'renameChat',
                    chatId: chatId,
                    newName: newName
                });

                document.body.removeChild(overlay);
            };

            actions.appendChild(cancelButton);
            actions.appendChild(saveButton);

            content.appendChild(header);
            content.appendChild(input);
            content.appendChild(actions);
            overlay.appendChild(content);

            document.body.appendChild(overlay);
            input.focus();
            input.select();

            input.onkeydown = function(e) {
                if (e.key === 'Enter') {
                    saveButton.click();
                } else if (e.key === 'Escape') {
                    cancelButton.click();
                }
            };
        }

        function showDeleteDialog(chatId, chatName) {
            if (isOperationInProgress || pendingOperations.has(chatId)) {
                return;
            }

            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';

            const content = document.createElement('div');
            content.className = 'modal-content';

            const header = document.createElement('div');
            header.className = 'modal-header';
            header.textContent = 'Delete Chat';

            const message = document.createElement('div');
            message.style.marginBottom = '16px';
            message.style.color = 'var(--vscode-foreground)';
            message.style.fontSize = '13px';
            message.innerHTML = 'Are you sure you want to delete "' + chatName + '"? <br>This action cannot be undone.';

            const actions = document.createElement('div');
            actions.className = 'modal-actions';

            const cancelButton = document.createElement('button');
            cancelButton.className = 'modal-button secondary';
            cancelButton.textContent = 'Cancel';
            cancelButton.onclick = function() {
                document.body.removeChild(overlay);
            };

            const deleteButton = document.createElement('button');
            deleteButton.className = 'modal-button primary';
            deleteButton.textContent = 'Delete';
            deleteButton.style.backgroundColor = 'var(--vscode-errorForeground)';
            deleteButton.style.color = 'var(--vscode-button-background)';
            deleteButton.onclick = function() {
                isOperationInProgress = true;
                pendingOperations.add(chatId);

                vscode.postMessage({
                    command: 'deleteChat',
                    chatId: chatId
                });

                document.body.removeChild(overlay);
            };

            actions.appendChild(cancelButton);
            actions.appendChild(deleteButton);

            content.appendChild(header);
            content.appendChild(message);
            content.appendChild(actions);
            overlay.appendChild(content);

            document.body.appendChild(overlay);
            deleteButton.focus();

            overlay.onkeydown = function(e) {
                if (e.key === 'Enter') {
                    deleteButton.click();
                } else if (e.key === 'Escape') {
                    cancelButton.click();
                }
            };
        }
    </script>
</body>
</html>`;
    }
}
