import * as vscode from "vscode";
import { ChatPanel } from "./chatPanel";

export function activate(context: vscode.ExtensionContext) {
    const openChat = vscode.commands.registerCommand(
        "ollama.openChat",
        () => {
        ChatPanel.createOrShow(context.extensionUri, context);
    });

    const statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right
    );

    statusBarItem.command = "ollama.openChat";
    statusBarItem.text = "$(comment-discussion) Ollama Chat";
    statusBarItem.tooltip = "Click to open Ollama Local Chat";
    
    statusBarItem.show();

    context.subscriptions.push(openChat, statusBarItem);
}

export function deactivate() {}