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
const settingsButton = document.getElementById('settingsButton');

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

if (settingsButton) {
    settingsButton.addEventListener('click', () => {
        vscode.postMessage({ command: 'openSettings' });
    });
}
