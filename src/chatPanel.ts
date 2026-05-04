import * as vscode from "vscode";
import { OllamaClient, OllamaMessage } from "./ollamaClient";

interface SavedChat {
    id: string;
    name: string;
    messages: OllamaMessage[];
    model: string;
    createdAt: number;
    updatedAt: number;
    aiTitleGenerated?: boolean;
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

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        context: vscode.ExtensionContext,
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._context = context;
        this._ollamaClient = new OllamaClient();
        const savedModel = context.workspaceState.get<string>(
            "ollama.selectedModel",
        );
        const config = vscode.workspace.getConfiguration("ollama");
        this._selectedModel =
            savedModel || config.get<string>("model", "llama3.2:latest");

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(
            async (message: any) => {
                switch (message.command) {
                    case "sendMessage":
                        await this.handleSendMessage(message.text);
                        return;
                    case "editAndResend":
                        await this.handleEditAndResend(
                            message.messageId,
                            message.newText,
                        );
                        return;
                    case "clearChat":
                        this._messages = [];
                        this._messageIdCounter = 0;
                        this._currentChatId = null;
                        this._panel.webview.postMessage({
                            command: "clearChat",
                        });
                        this.loadChatHistory();
                        return;
                    case "checkConnection":
                        const isConnected =
                            await this._ollamaClient.checkConnection();
                        this._panel.webview.postMessage({
                            command: "connectionStatus",
                            connected: isConnected,
                        });
                        return;
                    case "getModels":
                        const models = await this._ollamaClient.listModels();
                        this._panel.webview.postMessage({
                            command: "modelsList",
                            models: models,
                            selectedModel: this._selectedModel,
                        });
                        return;
                    case "selectModel":
                        this._selectedModel = message.model;
                        this._context.workspaceState.update(
                            "ollama.selectedModel",
                            message.model,
                        );
                        if (this._currentChatId && this._messages.length > 0) {
                            await this.saveCurrentChat();
                        }
                        return;
                    case "stopMessage":
                        if (this._currentRequest) {
                            this._currentRequest.abort();
                            this._currentRequest = null;
                        }
                        return;
                    case "loadChat":
                        await this.loadChat(message.chatId);
                        return;
                    case "deleteChat":
                        await this.deleteChat(message.chatId);
                        return;
                    case "renameChat":
                        await this.renameChat(message.chatId, message.newName);
                        return;
                    case "getChatHistory":
                        this.loadChatHistory();
                        return;
                    case "toggleSidebar":
                        this._context.workspaceState.update(
                            "ollama.sidebarCollapsed",
                            message.collapsed,
                        );
                        return;
                    case "getSidebarState":
                        const sidebarCollapsed =
                            this._context.workspaceState.get<boolean>(
                                "ollama.sidebarCollapsed",
                                false,
                            );
                        this._panel.webview.postMessage({
                            command: "setSidebarState",
                            collapsed: sidebarCollapsed,
                        });
                        return;
                }
            },
            null,
            this._disposables,
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
        return trimmed.substring(0, maxLength - 3) + "...";
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

    private async withOperationLock<T>(
        operation: string,
        fn: () => Promise<T>,
    ): Promise<T> {
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

            const firstUserMessage = this._messages.find(
                (m) => m.role === "user",
            );
            const fallbackName = firstUserMessage
                ? this.generateChatName(firstUserMessage.content)
                : `Chat ${new Date(now).toLocaleString()}`;

            const existingChat = chats[this._currentChatId];
            const preservedName = existingChat?.name || fallbackName;

            const hasChanges =
                !existingChat ||
                existingChat.messages.length !== this._messages.length ||
                existingChat.model !== this._selectedModel ||
                JSON.stringify(existingChat.messages) !==
                    JSON.stringify(this._messages);

            if (!isNewChat && !hasChanges) {
                return;
            }

            const savedChat: SavedChat = {
                id: this._currentChatId,
                name: preservedName,
                messages: [...this._messages],
                model: this._selectedModel,
                createdAt: existingChat?.createdAt || now,
                updatedAt: now,
                aiTitleGenerated: existingChat?.aiTitleGenerated,
            };

            chats[this._currentChatId] = savedChat;
            await this._context.globalState.update("ollama.savedChats", chats);

            if (isNewChat) {
                this.loadChatHistory();
                if (firstUserMessage) {
                    void this.generateAITitle(
                        this._currentChatId,
                        firstUserMessage.content,
                    );
                }
            }
        } catch (error) {
            console.error("Failed to save chat:", error);
        }
    }

    private async generateAITitle(
        chatId: string,
        userMessage: string,
    ): Promise<void> {
        try {
            const truncated =
                userMessage.length > 500
                    ? userMessage.substring(0, 500)
                    : userMessage;

            const titleMessages: OllamaMessage[] = [
                {
                    role: "system",
                    content:
                        "You generate concise chat titles. Reply with ONLY the title text — 3 to 6 words, written in the SAME LANGUAGE as the user's message (e.g. Dutch input -> Dutch title, English input -> English title). Plain text only, no quotes, no markdown, no trailing punctuation, no prefix like 'Title:'.",
                },
                {
                    role: "user",
                    content: `Generate a short title in the same language as this message:\n\n${truncated}`,
                },
            ];

            const request = this._ollamaClient.chat(
                titleMessages,
                this._selectedModel,
            );
            const result = await request.promise;
            const title = this.sanitizeTitle(result.content);
            if (!title) {
                return;
            }

            const chats = this.getSavedChats();
            const chat = chats[chatId];
            if (!chat || chat.aiTitleGenerated) {
                return;
            }

            chats[chatId] = {
                ...chat,
                name: title,
                aiTitleGenerated: true,
                updatedAt: Date.now(),
            };
            await this._context.globalState.update("ollama.savedChats", chats);
            this.loadChatHistory();
        } catch (error) {
            console.error("Failed to generate AI title:", error);
        }
    }

    private sanitizeTitle(raw: string): string | null {
        let title = (raw || "").trim();
        title = title.split("\n")[0].trim();
        title = title.replace(
            /^(title|chat title|conversation title)\s*[:\-]\s*/i,
            "",
        );
        title = title.replace(/^["'`*_]+|["'`*_]+$/g, "");
        title = title.replace(/[.!?,:;]+$/, "").trim();
        if (title.length === 0) {
            return null;
        }
        if (title.length > 60) {
            title = title.substring(0, 60).trim() + "…";
        }
        return title;
    }

    private getSavedChats(): { [key: string]: SavedChat } {
        return this._context.globalState.get<{ [key: string]: SavedChat }>(
            "ollama.savedChats",
            {},
        );
    }

    private async loadChat(chatId: string) {
        const chats = this.getSavedChats();
        const chat = chats[chatId];

        if (!chat) {
            this._panel.webview.postMessage({
                command: "error",
                message: "Chat not found",
            });
            return;
        }

        this._currentChatId = chatId;
        this._messages = [...chat.messages];
        this._selectedModel = chat.model;

        this._messageIdCounter = this._messages.filter(
            (msg) => msg.role === "user",
        ).length;

        this._context.workspaceState.update("ollama.selectedModel", chat.model);

        const messagesWithIds = this._messages.map((msg, index) => {
            const messageId = msg.role === "user" ? index : undefined;
            return {
                role: msg.role,
                content: msg.content,
                thinking: msg.thinking,
                id: messageId,
            };
        });

        this._panel.webview.postMessage({
            command: "loadChatMessages",
            messages: messagesWithIds,
            model: chat.model,
            nextMessageId: this._messageIdCounter,
        });

        const models = await this._ollamaClient.listModels();
        this._panel.webview.postMessage({
            command: "modelsList",
            models: models,
            selectedModel: this._selectedModel,
        });
    }

    private async deleteChat(chatId: string) {
        if (!chatId || typeof chatId !== "string" || chatId.trim() === "") {
            this._panel.webview.postMessage({
                command: "error",
                message: "Invalid chat ID provided",
            });
            return;
        }

        const operationKey = `delete_${chatId}`;

        try {
            await this.withOperationLock(operationKey, async () => {
                const chats = this.getSavedChats();

                if (!chats[chatId]) {
                    this._panel.webview.postMessage({
                        command: "error",
                        message: "Chat not found or already deleted",
                    });
                    await this.refreshChatHistory();
                    return;
                }

                const wasCurrentChat = this._currentChatId === chatId;

                const updatedChats = { ...chats };
                delete updatedChats[chatId];

                await this._context.globalState.update(
                    "ollama.savedChats",
                    updatedChats,
                );

                if (wasCurrentChat) {
                    this._currentChatId = null;
                    this._messages = [];
                    this._messageIdCounter = 0;
                    this._panel.webview.postMessage({ command: "clearChat" });
                }

                await this.refreshChatHistory();

                this._panel.webview.postMessage({
                    command: "chatDeleted",
                    chatId: chatId,
                    wasCurrentChat: wasCurrentChat,
                });
            });
        } catch (error: any) {
            if (error.message?.includes("already in progress")) {
                this._panel.webview.postMessage({
                    command: "error",
                    message:
                        "Delete operation is already in progress for this chat. Please wait and try again.",
                });
                return;
            }

            console.error("Error deleting chat:", error);
            const errorMessage =
                error?.message ||
                "An unexpected error occurred while deleting the chat";
            this._panel.webview.postMessage({
                command: "error",
                message: `Failed to delete chat: ${errorMessage}`,
            });

            try {
                await this.refreshChatHistory();
            } catch (refreshError) {
                console.error(
                    "Failed to refresh chat history after delete error:",
                    refreshError,
                );
            }
        }
    }

    private async renameChat(chatId: string, newName: string) {
        if (!chatId || typeof chatId !== "string" || chatId.trim() === "") {
            this._panel.webview.postMessage({
                command: "error",
                message: "Invalid chat ID provided",
            });
            return;
        }

        const trimmedName = newName?.trim();
        if (!trimmedName || trimmedName.length === 0) {
            this._panel.webview.postMessage({
                command: "error",
                message: "Chat name cannot be empty",
            });
            return;
        }

        if (trimmedName.length > 100) {
            this._panel.webview.postMessage({
                command: "error",
                message:
                    "Chat name is too long (maximum 100 characters allowed)",
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
                        command: "error",
                        message: "Chat not found or may have been deleted",
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
                    aiTitleGenerated: true,
                    updatedAt: Date.now(),
                };

                const updatedChats = {
                    ...chats,
                    [chatId]: updatedChat,
                };

                await this._context.globalState.update(
                    "ollama.savedChats",
                    updatedChats,
                );

                await this.refreshChatHistory();

                this._panel.webview.postMessage({
                    command: "chatRenamed",
                    chatId: chatId,
                    newName: trimmedName,
                });
            });
        } catch (error: any) {
            if (error.message?.includes("already in progress")) {
                this._panel.webview.postMessage({
                    command: "error",
                    message:
                        "Rename operation is already in progress for this chat. Please wait and try again.",
                });
                return;
            }

            console.error("Error renaming chat:", error);
            const errorMessage =
                error?.message ||
                "An unexpected error occurred while renaming the chat";
            this._panel.webview.postMessage({
                command: "error",
                message: `Failed to rename chat: ${errorMessage}`,
            });

            try {
                await this.refreshChatHistory();
            } catch (refreshError) {
                console.error(
                    "Failed to refresh chat history after rename error:",
                    refreshError,
                );
            }
        }
    }

    private loadChatHistory() {
        const chats = this.getSavedChats();
        const chatList = Object.values(chats)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((chat) => ({
                id: chat.id,
                name: chat.name,
                updatedAt: chat.updatedAt,
            }));

        this._panel.webview.postMessage({
            command: "chatHistory",
            chats: chatList,
            currentChatId: this._currentChatId,
        });
    }

    private async refreshChatHistory() {
        await new Promise((resolve) => setTimeout(resolve, 50));
        this.loadChatHistory();
    }

    public static createOrShow(
        extensionUri: vscode.Uri,
        context: vscode.ExtensionContext,
    ) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ChatPanel.currentPanel) {
            ChatPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            "ollamaChat",
            "Ollama Chat",
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
            },
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
            role: "user",
            content: text,
        };

        this._messages.push(userMessage);
        this._panel.webview.postMessage({
            command: "addMessage",
            message: { id: messageId, role: "user", content: text },
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
            if (this._messages[i].role === "user") {
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
            command: "editMessage",
            messageId: messageId,
            newContent: newText,
        });

        this._panel.webview.postMessage({
            command: "removeMessagesAfter",
            messageId: messageId,
        });

        await this.sendAssistantResponse();
        await this.saveCurrentChat();
    }

    private async sendAssistantResponse() {
        const assistantMessage: OllamaMessage = {
            role: "assistant",
            content: "",
        };

        this._panel.webview.postMessage({
            command: "addMessage",
            message: { role: "assistant", content: "" },
        });

        try {
            let fullResponse = "";
            let fullThinking = "";
            const request = this._ollamaClient.chat(
                this._messages,
                this._selectedModel,
                (chunk) => {
                    fullResponse += chunk;
                    this._panel.webview.postMessage({
                        command: "updateMessage",
                        content: fullResponse,
                    });
                },
                (thinking) => {
                    fullThinking = thinking;
                    this._panel.webview.postMessage({
                        command: "updateThinking",
                        thinking: fullThinking,
                    });
                },
            );

            this._currentRequest = request;

            const result = await request.promise;

            this._currentRequest = null;
            assistantMessage.content = result.content;
            if (result.thinking) {
                assistantMessage.thinking = result.thinking;
            }
            const lastIndex = this._messages.length - 1;
            if (this._messages[lastIndex]?.role === "assistant") {
                this._messages[lastIndex] = assistantMessage;
            } else {
                this._messages.push(assistantMessage);
            }
            await this.saveCurrentChat();
        } catch (error: any) {
            this._currentRequest = null;
            const errorMessage = error.message || "An error occurred";
            if (
                errorMessage.includes("destroyed") ||
                errorMessage.includes("aborted")
            ) {
                this._panel.webview.postMessage({
                    command: "messageStopped",
                });
            } else {
                this._panel.webview.postMessage({
                    command: "error",
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
        :root {
            --radius-sm: 6px;
            --radius-md: 10px;
            --radius-lg: 14px;
            --radius-xl: 20px;
            --space-1: 4px;
            --space-2: 8px;
            --space-3: 12px;
            --space-4: 16px;
            --space-5: 20px;
            --space-6: 24px;
            --transition: 180ms cubic-bezier(0.4, 0, 0.2, 1);
        }

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

        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }

        /* Sidebar */
        .chat-sidebar {
            width: 280px;
            flex-shrink: 0;
            border-right: 1px solid var(--vscode-panel-border);
            display: flex;
            flex-direction: column;
            background-color: var(--vscode-sideBar-background);
            overflow: hidden;
            transition: width var(--transition), border-right-color var(--transition);
        }

        .chat-sidebar.collapsed {
            width: 0;
            border-right-color: transparent;
        }

        .sidebar-header {
            padding: var(--space-4) var(--space-4) var(--space-3);
            display: flex;
            flex-direction: column;
            gap: var(--space-3);
        }

        .sidebar-title {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.6px;
            color: var(--vscode-descriptionForeground);
            opacity: 0.85;
        }

        .sidebar-new-chat {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: var(--space-2);
            padding: var(--space-2) var(--space-3);
            border: 1px solid var(--vscode-panel-border);
            background-color: transparent;
            color: var(--vscode-foreground);
            border-radius: var(--radius-md);
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            font-family: inherit;
            transition: background-color var(--transition), border-color var(--transition);
            height: 36px;
        }

        .sidebar-new-chat:hover {
            background-color: var(--vscode-list-hoverBackground);
            border-color: var(--vscode-focusBorder);
        }

        .chat-list {
            flex: 1;
            overflow-y: auto;
            padding: var(--space-2);
        }

        .chat-list-empty {
            padding: var(--space-5) var(--space-3);
            text-align: center;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            opacity: 0.7;
        }

        .chat-item {
            padding: var(--space-2) var(--space-3);
            margin: 2px 0;
            border-radius: var(--radius-md);
            cursor: pointer;
            display: flex;
            flex-direction: column;
            gap: 2px;
            position: relative;
            transition: background-color var(--transition);
            border: 1px solid transparent;
        }

        .chat-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .chat-item.active {
            background-color: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }

        .chat-item-name {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 13px;
            font-weight: 500;
        }

        .chat-item-time {
            font-size: 11px;
            opacity: 0.65;
        }

        /* Main */
        .main-container {
            display: flex;
            flex-direction: column;
            flex: 1;
            overflow: hidden;
            min-width: 0;
        }

        .header {
            padding: var(--space-3) var(--space-4);
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            align-items: center;
            gap: var(--space-3);
            min-height: 52px;
        }

        .header-left {
            display: flex;
            align-items: center;
            gap: var(--space-2);
            flex: 1;
            min-width: 0;
        }

        .sidebar-toggle {
            background: transparent;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            padding: 6px;
            border-radius: var(--radius-sm);
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0.7;
            transition: opacity var(--transition), background-color var(--transition);
            flex-shrink: 0;
        }

        .sidebar-toggle svg { width: 18px; height: 18px; }

        .sidebar-toggle:hover {
            opacity: 1;
            background-color: var(--vscode-toolbar-hoverBackground);
        }

        .header-title {
            font-size: 14px;
            font-weight: 600;
            letter-spacing: -0.2px;
        }

        .status-indicator {
            display: inline-flex;
            align-items: center;
            gap: var(--space-2);
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            padding: 5px 10px;
            border-radius: 999px;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-panel-border);
            user-select: none;
        }

        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background-color: #f44336;
            box-shadow: 0 0 0 3px rgba(244, 67, 54, 0.18);
            transition: background-color var(--transition), box-shadow var(--transition);
        }

        .status-indicator.connected .status-dot {
            background-color: #4caf50;
            box-shadow: 0 0 0 3px rgba(76, 175, 80, 0.18);
        }

        /* Chat area */
        .chat-container {
            flex: 1;
            overflow-y: auto;
            padding: var(--space-6) var(--space-5);
            display: flex;
            flex-direction: column;
            gap: var(--space-5);
            scroll-behavior: smooth;
        }

        .empty-state {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: var(--space-3);
            color: var(--vscode-descriptionForeground);
            text-align: center;
            padding: var(--space-6);
        }

        .empty-state-icon {
            width: 56px;
            height: 56px;
            border-radius: 50%;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-panel-border);
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--vscode-foreground);
            opacity: 0.7;
            margin-bottom: var(--space-2);
        }

        .empty-state-title {
            font-size: 15px;
            font-weight: 600;
            color: var(--vscode-foreground);
        }

        .empty-state-subtitle {
            font-size: 12px;
            opacity: 0.7;
            max-width: 320px;
            line-height: 1.5;
        }

        /* Messages */
        .message {
            display: flex;
            flex-direction: row;
            gap: var(--space-3);
            max-width: 100%;
            animation: fadeIn 240ms cubic-bezier(0.4, 0, 0.2, 1);
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(6px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .message.user { flex-direction: row-reverse; }

        .avatar {
            width: 30px;
            height: 30px;
            border-radius: 50%;
            flex-shrink: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            font-weight: 600;
            margin-top: 18px;
        }

        .message.user .avatar {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .message.assistant .avatar {
            background-color: var(--vscode-input-background);
            color: var(--vscode-foreground);
            border: 1px solid var(--vscode-panel-border);
        }

        .message-body {
            display: flex;
            flex-direction: column;
            gap: var(--space-1);
            max-width: 78%;
            min-width: 0;
        }

        .message.user .message-body { align-items: flex-end; }
        .message.editing .message-body { width: 100%; max-width: 100%; }

        .message-header {
            display: flex;
            align-items: center;
            gap: var(--space-2);
            font-size: 11px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            padding: 0 var(--space-2);
        }

        .message-actions {
            display: flex;
            gap: 2px;
            opacity: 0;
            transition: opacity var(--transition);
        }

        .message:hover .message-actions { opacity: 1; }

        .icon-button {
            background: none;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            padding: 3px 8px;
            font-size: 11px;
            font-weight: 500;
            border-radius: var(--radius-sm);
            opacity: 0.75;
            transition: opacity var(--transition), background-color var(--transition);
            font-family: inherit;
        }

        .icon-button:hover {
            opacity: 1;
            background-color: var(--vscode-toolbar-hoverBackground);
        }

        .message-content {
            padding: 10px 14px;
            border-radius: var(--radius-lg);
            line-height: 1.55;
            word-wrap: break-word;
            font-size: 13.5px;
        }

        .message.user .message-content {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-top-right-radius: var(--radius-sm);
        }

        .message.assistant .message-content {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-panel-border);
            border-top-left-radius: var(--radius-sm);
        }

        .message-content > *:first-child { margin-top: 0; }
        .message-content > *:last-child { margin-bottom: 0; }

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
        .message-content h1 { font-size: 1.4em; }
        .message-content h2 { font-size: 1.2em; }
        .message-content h3 { font-size: 1.05em; }

        .message-content p { margin: 0.5em 0; }

        .message-content ul,
        .message-content ol {
            margin: 0.5em 0;
            padding-left: 1.5em;
        }

        .message-content li { margin: 0.25em 0; }

        .message-content code {
            background-color: var(--vscode-textCodeBlock-background);
            color: var(--vscode-textPreformat-foreground);
            padding: 1px 6px;
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family);
            font-size: 0.88em;
        }

        .message-content pre {
            background-color: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: var(--radius-md);
            padding: 12px 14px;
            overflow-x: auto;
            margin: 0.6em 0;
        }

        .message-content pre code {
            background-color: transparent;
            padding: 0;
            display: block;
            white-space: pre;
            font-size: 0.9em;
            line-height: 1.5;
        }

        .message-content blockquote {
            border-left: 3px solid var(--vscode-focusBorder);
            padding-left: 12px;
            margin: 0.5em 0;
            color: var(--vscode-descriptionForeground);
        }

        .message-content table {
            border-collapse: collapse;
            margin: 0.5em 0;
            width: 100%;
            font-size: 0.92em;
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
            border-bottom: 1px solid transparent;
            transition: border-color var(--transition);
        }

        .message-content a:hover { border-bottom-color: currentColor; }

        .message-content hr {
            border: none;
            border-top: 1px solid var(--vscode-panel-border);
            margin: 1em 0;
        }

        /* Edit mode */
        .message-edit-textarea {
            width: 100%;
            padding: 10px 14px;
            border: 1px solid var(--vscode-focusBorder);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: var(--radius-lg);
            font-family: inherit;
            font-size: 13.5px;
            resize: none;
            min-height: 60px;
            box-sizing: border-box;
            line-height: 1.55;
        }

        .message-edit-textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 0;
        }

        .edit-actions {
            display: flex;
            gap: var(--space-2);
            margin-top: var(--space-2);
            justify-content: flex-end;
        }

        .edit-actions button {
            padding: 6px 12px;
            border: none;
            border-radius: var(--radius-sm);
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            font-family: inherit;
            transition: background-color var(--transition);
        }

        .edit-save {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .edit-save:hover { background-color: var(--vscode-button-hoverBackground); }

        .edit-cancel {
            background-color: transparent;
            color: var(--vscode-foreground);
            opacity: 0.75;
        }

        .edit-cancel:hover {
            opacity: 1;
            background-color: var(--vscode-toolbar-hoverBackground);
        }

        /* Thinking */
        .thinking-section { margin-bottom: var(--space-2); }

        .thinking-header {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            cursor: pointer;
            user-select: none;
            padding: 4px 10px;
            font-size: 11px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 999px;
            transition: color var(--transition), background-color var(--transition);
        }

        .thinking-header:hover {
            color: var(--vscode-foreground);
            background-color: var(--vscode-toolbar-hoverBackground);
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
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
        }

        .thinking-icon {
            width: 12px;
            height: 12px;
            display: inline-flex;
            transition: transform var(--transition);
        }

        .thinking-header.collapsed .thinking-icon {
            transform: rotate(-90deg);
        }

        .thinking-content {
            margin-top: var(--space-2);
            padding: 12px 14px;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: var(--radius-md);
            font-size: 12px;
            line-height: 1.6;
            color: var(--vscode-descriptionForeground);
            font-family: var(--vscode-editor-font-family);
            white-space: pre-wrap;
            word-wrap: break-word;
            max-height: 400px;
            overflow-y: auto;
        }

        .thinking-content.collapsed { display: none; }

        /* Input */
        .input-wrapper {
            padding: var(--space-3) var(--space-4) var(--space-4);
            border-top: 1px solid var(--vscode-panel-border);
        }

        .input-toolbar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: var(--space-2);
            padding: 0 var(--space-1);
        }

        .model-selector-wrapper {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .model-selector-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.4px;
        }

        .model-selector-wrapper select {
            padding: 4px 8px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: var(--radius-sm);
            font-family: inherit;
            font-size: 12px;
            cursor: pointer;
            outline: none;
            transition: border-color var(--transition);
        }

        .model-selector-wrapper select:hover { border-color: var(--vscode-focusBorder); }
        .model-selector-wrapper select:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }

        .input-hint {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            opacity: 0.6;
        }

        .input-container {
            position: relative;
            display: flex;
            align-items: flex-end;
            gap: var(--space-2);
            padding: var(--space-2);
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            border-radius: var(--radius-lg);
            transition: border-color var(--transition), box-shadow var(--transition);
        }

        .input-container:focus-within {
            border-color: var(--vscode-focusBorder);
        }

        .input-container textarea {
            flex: 1;
            padding: 6px 8px;
            border: none;
            background-color: transparent;
            color: var(--vscode-input-foreground);
            font-family: inherit;
            font-size: 13.5px;
            resize: none;
            min-height: 32px;
            height: 32px;
            max-height: 200px;
            outline: none;
            line-height: 1.5;
        }

        .input-container textarea::placeholder {
            color: var(--vscode-input-placeholderForeground);
            opacity: 0.7;
        }

        .send-button {
            flex-shrink: 0;
            width: 32px;
            height: 32px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: var(--radius-md);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background-color var(--transition), transform var(--transition);
            padding: 0;
        }

        .send-button:hover:not(:disabled) {
            background-color: var(--vscode-button-hoverBackground);
        }

        .send-button:active:not(:disabled) { transform: scale(0.96); }

        .send-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .send-button svg { width: 16px; height: 16px; }

        /* Error */
        .error {
            padding: 10px 12px;
            margin: var(--space-3) 0;
            background-color: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            border-radius: var(--radius-md);
            color: var(--vscode-errorForeground);
            font-size: 12.5px;
        }

        /* Context menu */
        .context-menu {
            position: fixed;
            background-color: var(--vscode-menu-background);
            border: 1px solid var(--vscode-menu-border);
            border-radius: var(--radius-md);
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
            z-index: 1000;
            min-width: 150px;
            padding: 4px;
            display: none;
        }

        .context-menu-item {
            padding: 6px 10px;
            cursor: pointer;
            font-size: 13px;
            color: var(--vscode-menu-foreground);
            user-select: none;
            border-radius: var(--radius-sm);
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .context-menu-item:hover {
            background-color: var(--vscode-menu-selectionBackground);
            color: var(--vscode-menu-selectionForeground);
        }

        .context-menu-item.danger { color: #e57373; }
        .context-menu-item.danger:hover {
            background-color: rgba(229, 115, 115, 0.15);
            color: #ef5350;
        }

        /* Modal */
        .modal-overlay {
            position: fixed;
            inset: 0;
            background-color: rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(2px);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 2000;
            animation: modalFadeIn 180ms ease-out;
        }

        @keyframes modalFadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }

        .modal-content {
            background-color: var(--vscode-quickInput-background);
            border: 1px solid var(--vscode-quickInput-border);
            border-radius: var(--radius-lg);
            padding: var(--space-5);
            min-width: 420px;
            max-width: 520px;
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
            animation: modalSlideIn 220ms cubic-bezier(0.4, 0, 0.2, 1);
        }

        @keyframes modalSlideIn {
            from { opacity: 0; transform: translateY(-12px) scale(0.98); }
            to { opacity: 1; transform: translateY(0) scale(1); }
        }

        .modal-header {
            font-size: 15px;
            font-weight: 600;
            margin-bottom: var(--space-4);
            color: var(--vscode-quickInput-foreground);
        }

        .modal-message {
            margin-bottom: var(--space-4);
            color: var(--vscode-descriptionForeground);
            font-size: 13px;
            line-height: 1.5;
        }

        .modal-input {
            width: 100%;
            padding: 8px 12px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: var(--radius-sm);
            font-family: inherit;
            font-size: 13px;
        }

        .modal-input:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
            border-color: var(--vscode-focusBorder);
        }

        .modal-actions {
            display: flex;
            gap: var(--space-2);
            justify-content: flex-end;
            margin-top: var(--space-4);
        }

        .modal-button {
            padding: 7px 14px;
            border: none;
            border-radius: var(--radius-sm);
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            font-family: inherit;
            transition: background-color var(--transition);
        }

        .modal-button.primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .modal-button.primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .modal-button.danger {
            background-color: #d32f2f;
            color: white;
        }

        .modal-button.danger:hover { background-color: #b71c1c; }

        .modal-button.secondary {
            background-color: transparent;
            color: var(--vscode-foreground);
        }

        .modal-button.secondary:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }
    </style>
</head>
<body>
    <div class="chat-sidebar" id="chatSidebar">
        <div class="sidebar-header">
            <div class="sidebar-title">Chats</div>
            <button class="sidebar-new-chat" id="newChatButton" title="New chat">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
                <span>New chat</span>
            </button>
        </div>
        <div class="chat-list" id="chatList"></div>
        <div class="context-menu" id="contextMenu">
            <div class="context-menu-item" id="renameMenuItem">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                <span>Rename</span>
            </div>
            <div class="context-menu-item danger" id="deleteMenuItem">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                <span>Delete</span>
            </div>
        </div>
    </div>
    <div class="main-container">
        <div class="header">
            <div class="header-left">
                <button id="sidebarToggle" class="sidebar-toggle" title="Toggle sidebar">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
                </button>
                <div class="header-title">Ollama Chat</div>
            </div>
            <div class="status-indicator" id="status">
                <span class="status-dot"></span>
                <span id="statusText">Disconnected</span>
            </div>
        </div>
        <div class="chat-container" id="chatContainer">
            <div class="empty-state">
                <div class="empty-state-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                </div>
                <div class="empty-state-title">Start a conversation</div>
                <div class="empty-state-subtitle">Type a message below to chat with your local Ollama model.</div>
            </div>
        </div>
        <div class="input-wrapper">
            <div class="input-toolbar">
                <div class="model-selector-wrapper">
                    <span class="model-selector-label">Model</span>
                    <select id="modelSelect">
                        <option value="">Loading...</option>
                    </select>
                </div>
                <span class="input-hint">Enter to send · Shift+Enter for new line</span>
            </div>
            <div class="input-container">
                <textarea id="messageInput" placeholder="Send a message..." rows="1"></textarea>
                <button id="sendButton" class="send-button" title="Send (Enter)"></button>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const chatContainer = document.getElementById('chatContainer');
        const messageInput = document.getElementById('messageInput');
        const sendButton = document.getElementById('sendButton');
        const status = document.getElementById('status');
        const statusText = document.getElementById('statusText');
        const modelSelect = document.getElementById('modelSelect');
        const newChatButton = document.getElementById('newChatButton');
        const sidebarToggle = document.getElementById('sidebarToggle');
        const chatSidebar = document.getElementById('chatSidebar');
        const chatList = document.getElementById('chatList');
        const contextMenu = document.getElementById('contextMenu');
        const renameMenuItem = document.getElementById('renameMenuItem');
        const deleteMenuItem = document.getElementById('deleteMenuItem');

        const SEND_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
        const STOP_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
        const ASSISTANT_AVATAR = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>';
        const CHEVRON_LEFT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
        const CHEVRON_RIGHT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';

        let isLoading = false;
        let userMessageIdCounter = 0;
        let currentChatId = null;
        let contextMenuChatId = null;
        let contextMenuChatName = null;
        let isOperationInProgress = false;
        let pendingOperations = new Set();
        let sidebarCollapsed = false;

        function setSendIcon(loading) {
            sendButton.innerHTML = loading ? STOP_SVG : SEND_SVG;
        }

        function formatRelativeTime(timestamp) {
            const now = Date.now();
            const diff = now - timestamp;
            const minute = 60 * 1000;
            const hour = 60 * minute;
            const day = 24 * hour;
            if (diff < minute) return 'Just now';
            if (diff < hour) return Math.floor(diff / minute) + 'm ago';
            if (diff < day) return Math.floor(diff / hour) + 'h ago';
            if (diff < 7 * day) return Math.floor(diff / day) + 'd ago';
            return new Date(timestamp).toLocaleDateString();
        }

        function applySidebarState() {
            if (sidebarCollapsed) {
                chatSidebar.classList.add('collapsed');
                sidebarToggle.innerHTML = CHEVRON_RIGHT;
            } else {
                chatSidebar.classList.remove('collapsed');
                sidebarToggle.innerHTML = CHEVRON_LEFT;
            }
        }

        function toggleSidebar() {
            sidebarCollapsed = !sidebarCollapsed;
            applySidebarState();
            vscode.postMessage({ command: 'toggleSidebar', collapsed: sidebarCollapsed });
        }

        function renderMarkdown(content) {
            if (!content) return '';
            const html = marked.parse(content);
            return DOMPurify.sanitize(html);
        }

        function updateStatus(connected) {
            if (connected) {
                statusText.textContent = 'Connected';
                status.classList.add('connected');
            } else {
                statusText.textContent = 'Disconnected';
                status.classList.remove('connected');
            }
        }

        function ensureNotEmpty() {
            const emptyState = chatContainer.querySelector('.empty-state');
            if (emptyState) emptyState.remove();
        }

        function buildAvatar(role) {
            const av = document.createElement('div');
            av.className = 'avatar';
            if (role === 'user') {
                av.textContent = 'U';
            } else {
                av.innerHTML = ASSISTANT_AVATAR;
            }
            return av;
        }

        function showEmptyState() {
            chatContainer.innerHTML = ''
                + '<div class="empty-state">'
                + '<div class="empty-state-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>'
                + '<div class="empty-state-title">Start a conversation</div>'
                + '<div class="empty-state-subtitle">Type a message below to chat with your local Ollama model.</div>'
                + '</div>';
        }

        function addMessage(role, content, messageId, thinking) {
            ensureNotEmpty();

            const messageDiv = document.createElement('div');
            messageDiv.className = 'message ' + role;
            if (role === 'user' && messageId !== undefined) {
                messageDiv.dataset.messageId = messageId;
            }

            messageDiv.appendChild(buildAvatar(role));

            const body = document.createElement('div');
            body.className = 'message-body';

            const header = document.createElement('div');
            header.className = 'message-header';
            const headerText = document.createElement('span');
            headerText.textContent = role === 'user' ? 'You' : 'Ollama';
            header.appendChild(headerText);

            if (role === 'user') {
                const actions = document.createElement('div');
                actions.className = 'message-actions';
                const editButton = document.createElement('button');
                editButton.className = 'icon-button';
                editButton.textContent = 'Edit';
                editButton.title = 'Edit message';
                editButton.addEventListener('click', () => editUserMessage(messageDiv));
                actions.appendChild(editButton);
                header.appendChild(actions);
            }

            body.appendChild(header);

            if (role === 'assistant') {
                const thinkingSection = document.createElement('div');
                thinkingSection.className = 'thinking-section';
                thinkingSection.style.display = 'none';

                const thinkingHeader = document.createElement('div');
                thinkingHeader.className = 'thinking-header collapsed';
                thinkingHeader.innerHTML = '<svg class="thinking-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg><span>Thinking</span>';

                const thinkingContent = document.createElement('div');
                thinkingContent.className = 'thinking-content collapsed';
                thinkingContent.textContent = '';

                thinkingHeader.addEventListener('click', () => {
                    const collapsed = thinkingHeader.classList.contains('collapsed');
                    if (collapsed) {
                        thinkingHeader.classList.remove('collapsed');
                        thinkingContent.classList.remove('collapsed');
                    } else {
                        thinkingHeader.classList.add('collapsed');
                        thinkingContent.classList.add('collapsed');
                    }
                });

                thinkingSection.appendChild(thinkingHeader);
                thinkingSection.appendChild(thinkingContent);
                body.appendChild(thinkingSection);
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
            body.appendChild(contentDiv);

            messageDiv.appendChild(body);
            chatContainer.appendChild(messageDiv);
            chatContainer.scrollTop = chatContainer.scrollHeight;
            return contentDiv;
        }

        function editUserMessage(messageDiv) {
            if (messageDiv.classList.contains('editing')) return;

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
            cancelButton.addEventListener('click', () => cancelEdit(messageDiv, originalText));

            editActions.appendChild(saveButton);
            editActions.appendChild(cancelButton);

            contentDiv.replaceWith(textarea);
            const body = messageDiv.querySelector('.message-body');
            body.appendChild(editActions);

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

            if (textarea) {
                textarea.replaceWith(contentDiv);
            }
            if (editActions) editActions.remove();
        }

        function editMessage(messageId, newContent) {
            const messageDiv = chatContainer.querySelector('[data-message-id="' + messageId + '"]');
            if (messageDiv) {
                const contentDiv = messageDiv.querySelector('.message-content');
                if (contentDiv) contentDiv.textContent = newContent;
            }
        }

        function removeMessagesAfter(messageId) {
            const messageDiv = chatContainer.querySelector('[data-message-id="' + messageId + '"]');
            if (!messageDiv) return;
            let removeNext = false;
            Array.from(chatContainer.querySelectorAll('.message')).forEach(msg => {
                if (removeNext) msg.remove();
                else if (msg === messageDiv) removeNext = true;
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
                        if (thinkingHeader) thinkingHeader.classList.add('shimmer');
                    } else {
                        lastMessage._thinkingSection.style.display = 'none';
                        if (thinkingHeader) thinkingHeader.classList.remove('shimmer');
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

        function removeEmptyAssistantPlaceholder() {
            const messages = chatContainer.querySelectorAll('.message.assistant');
            if (messages.length === 0) return;
            const last = messages[messages.length - 1];
            const contentDiv = last.querySelector('.message-content');
            const hasText = contentDiv && (contentDiv.textContent || '').trim().length > 0;
            const hasMarkup = contentDiv && contentDiv.innerHTML.trim().length > 0;
            const thinkingSection = last._thinkingSection;
            const hasThinking = thinkingSection && thinkingSection.style.display !== 'none';
            if (!hasText && !hasMarkup && !hasThinking) {
                last.remove();
            }
        }

        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        messageInput.addEventListener('input', () => {
            messageInput.style.height = '32px';
            messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
        });

        sendButton.addEventListener('click', () => {
            if (isLoading) stopMessage();
            else sendMessage();
        });

        function sendMessage() {
            const text = messageInput.value.trim();
            if (!text || isLoading) return;

            isLoading = true;
            sendButton.disabled = false;
            messageInput.disabled = true;
            setSendIcon(true);

            vscode.postMessage({ command: 'sendMessage', text: text });

            messageInput.value = '';
            messageInput.style.height = '32px';
        }

        function stopMessage() {
            if (!isLoading) return;
            vscode.postMessage({ command: 'stopMessage' });
            isLoading = false;
            sendButton.disabled = false;
            messageInput.disabled = false;
            setSendIcon(false);
            messageInput.focus();
        }

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'addMessage':
                    const msgId = message.message.id !== undefined
                        ? message.message.id
                        : (message.message.role === 'user' ? userMessageIdCounter++ : undefined);
                    addMessage(message.message.role, message.message.content, msgId, message.message.thinking);
                    if (message.message.role === 'assistant') {
                        isLoading = false;
                        sendButton.disabled = false;
                        messageInput.disabled = false;
                        setSendIcon(false);
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
                    removeEmptyAssistantPlaceholder();
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
                    setSendIcon(false);
                    messageInput.focus();
                    break;
                case 'connectionStatus':
                    updateStatus(message.connected);
                    break;
                case 'clearChat':
                    showEmptyState();
                    userMessageIdCounter = 0;
                    currentChatId = null;
                    break;
                case 'messageStopped':
                    removeEmptyAssistantPlaceholder();
                    isLoading = false;
                    sendButton.disabled = false;
                    messageInput.disabled = false;
                    setSendIcon(false);
                    messageInput.focus();
                    break;
                case 'modelsList':
                    if (modelSelect) {
                        modelSelect.innerHTML = '';
                        if (message.models && message.models.length > 0) {
                            let matched = false;
                            message.models.forEach(model => {
                                const option = document.createElement('option');
                                option.value = model;
                                option.textContent = model;
                                if (model === message.selectedModel) {
                                    option.selected = true;
                                    matched = true;
                                }
                                modelSelect.appendChild(option);
                            });
                            if (!matched && modelSelect.options.length > 0) {
                                modelSelect.options[0].selected = true;
                                vscode.postMessage({
                                    command: 'selectModel',
                                    model: modelSelect.options[0].value
                                });
                            }
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
                        showEmptyState();
                    }
                    if (message.model && modelSelect) {
                        Array.from(modelSelect.options).forEach(opt => {
                            if (opt.value === message.model) opt.selected = true;
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
                    if (message.wasCurrentChat) currentChatId = null;
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
                    applySidebarState();
                    break;
            }
        });

        function loadModels() {
            vscode.postMessage({ command: 'getModels' });
        }

        modelSelect.addEventListener('change', (e) => {
            const selectedModel = e.target.value;
            if (selectedModel) {
                vscode.postMessage({ command: 'selectModel', model: selectedModel });
            }
        });

        function renderChatHistory(chats, activeChatId) {
            if (!chatList) return;

            chatList.innerHTML = '';
            currentChatId = activeChatId;

            if (chats.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'chat-list-empty';
                empty.textContent = 'No saved chats yet';
                chatList.appendChild(empty);
                return;
            }

            chats.forEach(chat => {
                const item = document.createElement('div');
                item.className = 'chat-item';
                if (chat.id === activeChatId) item.classList.add('active');

                const name = document.createElement('div');
                name.className = 'chat-item-name';
                name.textContent = chat.name;
                name.title = chat.name;

                const time = document.createElement('div');
                time.className = 'chat-item-time';
                time.textContent = formatRelativeTime(chat.updatedAt);

                item.appendChild(name);
                item.appendChild(time);

                item.addEventListener('click', () => {
                    if (chat.id !== activeChatId) {
                        vscode.postMessage({ command: 'loadChat', chatId: chat.id });
                    }
                });

                item.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    showContextMenu(e, chat.id, chat.name);
                });

                chatList.appendChild(item);
            });
        }

        function showContextMenu(event, chatId, chatName) {
            if (!contextMenu || isOperationInProgress || pendingOperations.has(chatId)) return;

            contextMenuChatId = chatId;
            contextMenuChatName = chatName;

            contextMenu.style.display = 'block';
            const menuRect = contextMenu.getBoundingClientRect();
            let left = event.clientX;
            let top = event.clientY;
            if (left + menuRect.width > window.innerWidth) left = window.innerWidth - menuRect.width - 8;
            if (top + menuRect.height > window.innerHeight) top = window.innerHeight - menuRect.height - 8;
            contextMenu.style.left = left + 'px';
            contextMenu.style.top = top + 'px';

            const hideMenu = (e) => {
                if (contextMenu && !contextMenu.contains(e.target)) {
                    contextMenu.style.display = 'none';
                    document.removeEventListener('click', hideMenu);
                }
            };

            setTimeout(() => document.addEventListener('click', hideMenu), 0);
        }

        if (renameMenuItem) {
            renameMenuItem.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const chatId = contextMenuChatId;
                const chatName = contextMenuChatName;
                if (!chatId || !chatName || isOperationInProgress || pendingOperations.has(chatId)) {
                    if (contextMenu) contextMenu.style.display = 'none';
                    return;
                }
                if (contextMenu) contextMenu.style.display = 'none';
                showRenameDialog(chatId, chatName);
            });
        }

        if (deleteMenuItem) {
            deleteMenuItem.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const chatId = contextMenuChatId;
                if (!chatId || isOperationInProgress || pendingOperations.has(chatId)) {
                    if (contextMenu) contextMenu.style.display = 'none';
                    return;
                }
                if (contextMenu) contextMenu.style.display = 'none';
                showDeleteDialog(chatId, contextMenuChatName);
            });
        }

        if (newChatButton) {
            newChatButton.addEventListener('click', () => {
                vscode.postMessage({ command: 'clearChat' });
            });
        }

        if (sidebarToggle) {
            sidebarToggle.addEventListener('click', toggleSidebar);
        }

        setSendIcon(false);
        vscode.postMessage({ command: 'checkConnection' });
        vscode.postMessage({ command: 'getSidebarState' });
        vscode.postMessage({ command: 'getChatHistory' });
        loadModels();
        setInterval(() => vscode.postMessage({ command: 'checkConnection' }), 5000);

        function showRenameDialog(chatId, currentName) {
            if (isOperationInProgress || pendingOperations.has(chatId)) return;

            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';

            const content = document.createElement('div');
            content.className = 'modal-content';

            const header = document.createElement('div');
            header.className = 'modal-header';
            header.textContent = 'Rename chat';

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
            cancelButton.onclick = () => document.body.removeChild(overlay);

            const saveButton = document.createElement('button');
            saveButton.className = 'modal-button primary';
            saveButton.textContent = 'Rename';
            saveButton.onclick = () => {
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
                vscode.postMessage({ command: 'renameChat', chatId: chatId, newName: newName });
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

            input.onkeydown = (e) => {
                if (e.key === 'Enter') saveButton.click();
                else if (e.key === 'Escape') cancelButton.click();
            };
        }

        function showDeleteDialog(chatId, chatName) {
            if (isOperationInProgress || pendingOperations.has(chatId)) return;

            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';

            const content = document.createElement('div');
            content.className = 'modal-content';

            const header = document.createElement('div');
            header.className = 'modal-header';
            header.textContent = 'Delete chat?';

            const message = document.createElement('div');
            message.className = 'modal-message';
            message.textContent = 'Are you sure you want to delete "' + chatName + '"? This action cannot be undone.';

            const actions = document.createElement('div');
            actions.className = 'modal-actions';

            const cancelButton = document.createElement('button');
            cancelButton.className = 'modal-button secondary';
            cancelButton.textContent = 'Cancel';
            cancelButton.onclick = () => document.body.removeChild(overlay);

            const deleteButton = document.createElement('button');
            deleteButton.className = 'modal-button danger';
            deleteButton.textContent = 'Delete';
            deleteButton.onclick = () => {
                isOperationInProgress = true;
                pendingOperations.add(chatId);
                vscode.postMessage({ command: 'deleteChat', chatId: chatId });
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

            overlay.onkeydown = (e) => {
                if (e.key === 'Enter') deleteButton.click();
                else if (e.key === 'Escape') cancelButton.click();
            };
        }
    </script>
</body>
</html>`;
    }
}
