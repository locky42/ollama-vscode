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
                    case "openSettings":
                        vscode.commands.executeCommand('workbench.action.openSettings', '@ext:maurokrekels.ollama-chat-vscode');
                        return;
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
        const vscode = require('vscode');
        const fs = require('fs');

        const cssUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'src', 'assets', 'css', 'panel.css')
        );
        const jsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'src', 'assets', 'js', 'panel.js')
        );

        const htmlUri = vscode.Uri.joinPath(this._extensionUri, 'src', 'templates', 'panel.html');
        const htmlPath = htmlUri.fsPath;
        let html = fs.readFileSync(htmlPath, 'utf8');

        html = html.replace(
            /<link rel="stylesheet" href="..\/assets\/css\/panel.css">/,
            `<link rel="stylesheet" href="${cssUri}">`
        );
        html = html.replace(
            /<script src="..\/assets\/js\/panel.js"><\/script>/,
            `<script src="${jsUri}"></script>`
        );

        return html;
    }
}
