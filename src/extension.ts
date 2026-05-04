import * as vscode from "vscode";
import { ChatPanel } from "./chatPanel";

export function activate(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand(
        "ollama.openChat",
        () => {
            ChatPanel.createOrShow(context.extensionUri, context);
        },
    );

    context.subscriptions.push(disposable);
}

export function deactivate() {}
