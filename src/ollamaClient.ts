import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

export interface OllamaMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    thinking?: string;
}

export interface OllamaResponse {
    model: string;
    created_at: string;
    message: {
        role: string;
        content: string;
    };
    done: boolean;
}

export class OllamaClient {
    private baseUrl: string;
    private model: string;

    constructor() {
        const config = vscode.workspace.getConfiguration('ollama');
        this.baseUrl = config.get<string>('baseUrl', 'http://localhost:11434');
        this.model = config.get<string>('model', 'llama2');
    }

    private makeRequest(path: string, method: string = 'GET', body?: any): Promise<any> {
        return new Promise((resolve, reject) => {
            let baseUrl = this.baseUrl.trim();
            if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
                baseUrl = 'http://' + baseUrl;
            }
            const baseUrlObj = new URL(baseUrl);
            const isHttps = baseUrlObj.protocol === 'https:';
            const httpModule = isHttps ? https : http;

            const requestBody = body ? JSON.stringify(body) : undefined;

            const port = baseUrlObj.port ? parseInt(baseUrlObj.port, 10) : (isHttps ? 443 : 80);

            const options: any = {
                host: baseUrlObj.host,
                hostname: baseUrlObj.hostname,
                port: port,
                path: path,
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                },
            };

            if (requestBody) {
                options.headers['Content-Length'] = Buffer.byteLength(requestBody);
            }

            const req = httpModule.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(JSON.parse(data));
                        } catch (e) {
                            resolve(data);
                        }
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
                    }
                });
            });

            req.on('error', (error) => {
                reject(error);
            });

            if (requestBody) {
                req.write(requestBody);
            }

            req.end();
        });
    }

    async checkConnection(): Promise<boolean> {
        try {
            await this.makeRequest('/api/tags');
            return true;
        } catch (error) {
            return false;
        }
    }

    async listModels(): Promise<string[]> {
        try {
            const response = await this.makeRequest('/api/tags');
            return response.models?.map((m: any) => m.name) || [];
        } catch (error) {
            return [];
        }
    }

    async pullModel(modelName: string, onProgress?: (progress: any) => void): Promise<void> {
        return new Promise((resolve, reject) => {
            let baseUrl = this.baseUrl.trim();
            if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
                baseUrl = 'http://' + baseUrl;
            }
            const baseUrlObj = new URL(baseUrl);
            const isHttps = baseUrlObj.protocol === 'https:';
            const httpModule = isHttps ? https : http;

            const requestBody = JSON.stringify({
                name: modelName,
                stream: true,
            });

            const port = baseUrlObj.port ? parseInt(baseUrlObj.port, 10) : (isHttps ? 443 : 80);

            const options = {
                host: baseUrlObj.host,
                hostname: baseUrlObj.hostname,
                port: port,
                path: '/api/pull',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(requestBody),
                },
            };

            const req = httpModule.request(options, (res) => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    let buffer = '';

                    res.on('data', (chunk: Buffer) => {
                        buffer += chunk.toString();
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || '';

                        for (const line of lines) {
                            if (line.trim()) {
                                try {
                                    const data = JSON.parse(line);
                                    if (onProgress) {
                                        onProgress(data);
                                    }
                                    if (data.status === 'success') {
                                        resolve();
                                        return;
                                    }
                                } catch (e) {
                                }
                            }
                        }
                    });

                    res.on('end', () => {
                        if (buffer.trim()) {
                            try {
                                const data = JSON.parse(buffer);
                                if (onProgress) {
                                    onProgress(data);
                                }
                            } catch (e) {
                            }
                        }
                        resolve();
                    });

                    res.on('error', (error: Error) => {
                        reject(error);
                    });
                } else {
                    let errorBody = '';
                    res.on('data', (chunk: Buffer) => {
                        errorBody += chunk.toString();
                    });
                    res.on('end', () => {
                        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}${errorBody ? ' - ' + errorBody : ''}`));
                    });
                }
            });

            req.on('error', (error) => {
                reject(new Error(`Cannot connect to Ollama. ${error.message}`));
            });

            req.write(requestBody);
            req.end();
        });
    }

    chat(messages: OllamaMessage[], model?: string, onChunk?: (chunk: string) => void, onThinking?: (thinking: string) => void): { promise: Promise<{ content: string, thinking?: string }>, abort: () => void } {
        const config = vscode.workspace.getConfiguration('ollama');
        const chatModel = model || config.get<string>('model', this.model);

        let request: http.ClientRequest | null = null;
        let isAborted = false;

        const promise = new Promise<{ content: string, thinking?: string }>((resolve, reject) => {
            let baseUrl = this.baseUrl.trim();
            if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
                baseUrl = 'http://' + baseUrl;
            }
            const baseUrlObj = new URL(baseUrl);
            const isHttps = baseUrlObj.protocol === 'https:';
            const httpModule = isHttps ? https : http;

            const requestBody = JSON.stringify({
                model: chatModel,
                messages: messages,
                stream: true,
            });

            const port = baseUrlObj.port ? parseInt(baseUrlObj.port, 10) : (isHttps ? 443 : 80);

            const options = {
                host: baseUrlObj.host,
                hostname: baseUrlObj.hostname,
                port: port,
                path: '/api/chat',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(requestBody),
                },
            };

            request = httpModule.request(options, (res) => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    let fullResponse = '';
                    let fullThinking = '';
                    let buffer = '';
                    let inThinkingTag = false;
                    let thinkingBuffer = '';

                    res.on('data', (chunk: Buffer) => {
                        if (isAborted) {
                            return;
                        }
                        buffer += chunk.toString();
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || '';

                        for (const line of lines) {
                            if (isAborted) {
                                return;
                            }
                            if (line.trim()) {
                                try {
                                    const data = JSON.parse(line);
                                    if (data.message?.content) {
                                        let content = data.message.content;

                                        while (content.length > 0) {
                                            if (isAborted) {
                                                return;
                                            }
                                            if (!inThinkingTag) {
                                                const thinkStart = content.indexOf('<think>');
                                                if (thinkStart !== -1) {
                                                    fullResponse += content.substring(0, thinkStart);
                                                    if (onChunk && thinkStart > 0) {
                                                        onChunk(content.substring(0, thinkStart));
                                                    }
                                                    inThinkingTag = true;
                                                    content = content.substring(thinkStart + '<think>'.length);
                                                    thinkingBuffer = '';
                                                } else {
                                                    fullResponse += content;
                                                    if (onChunk) {
                                                        onChunk(content);
                                                    }
                                                    content = '';
                                                }
                                            } else {
                                                const thinkEnd = content.indexOf('</think>');
                                                if (thinkEnd !== -1) {
                                                    thinkingBuffer += content.substring(0, thinkEnd);
                                                    fullThinking += thinkingBuffer;
                                                    if (onThinking && thinkingBuffer) {
                                                        onThinking(fullThinking);
                                                    }
                                                    inThinkingTag = false;
                                                    thinkingBuffer = '';
                                                    content = content.substring(thinkEnd + '</think>'.length);
                                                } else {
                                                    thinkingBuffer += content;
                                                    if (onThinking && thinkingBuffer) {
                                                        onThinking(fullThinking + thinkingBuffer);
                                                    }
                                                    content = '';
                                                }
                                            }
                                        }
                                    }
                                    if (data.done) {
                                        if (isAborted) {
                                            return;
                                        }
                                        if (inThinkingTag && thinkingBuffer) {
                                            fullThinking += thinkingBuffer;
                                            if (onThinking && thinkingBuffer) {
                                                onThinking(fullThinking);
                                            }
                                        }
                                        resolve({ content: fullResponse, thinking: fullThinking || undefined });
                                        return;
                                    }
                                } catch (e) {
                                }
                            }
                        }
                    });

                    res.on('end', () => {
                        if (isAborted) {
                            return;
                        }
                        if (buffer.trim()) {
                            try {
                                const data = JSON.parse(buffer);
                                if (data.message?.content) {
                                    let content = data.message.content;

                                    while (content.length > 0) {
                                        if (isAborted) {
                                            return;
                                        }
                                        if (!inThinkingTag) {
                                            const thinkStart = content.indexOf('<think>');
                                            if (thinkStart !== -1) {
                                                fullResponse += content.substring(0, thinkStart);
                                                if (onChunk && thinkStart > 0) {
                                                    onChunk(content.substring(0, thinkStart));
                                                }
                                                inThinkingTag = true;
                                                content = content.substring(thinkStart + '<think>'.length);
                                                thinkingBuffer = '';
                                            } else {
                                                fullResponse += content;
                                                if (onChunk) {
                                                    onChunk(content);
                                                }
                                                content = '';
                                            }
                                        } else {
                                            const thinkEnd = content.indexOf('</think>');
                                            if (thinkEnd !== -1) {
                                                thinkingBuffer += content.substring(0, thinkEnd);
                                                fullThinking += thinkingBuffer;
                                                if (onThinking && thinkingBuffer) {
                                                    onThinking(fullThinking);
                                                }
                                                inThinkingTag = false;
                                                thinkingBuffer = '';
                                                content = content.substring(thinkEnd + '</think>'.length);
                                            } else {
                                                thinkingBuffer += content;
                                                if (onThinking && thinkingBuffer) {
                                                    onThinking(fullThinking + thinkingBuffer);
                                                }
                                                content = '';
                                            }
                                        }
                                    }
                                }
                            } catch (e) {
                            }
                        }
                        if (inThinkingTag && thinkingBuffer) {
                            fullThinking += thinkingBuffer;
                            if (onThinking && thinkingBuffer) {
                                onThinking(fullThinking);
                            }
                        }
                        resolve({ content: fullResponse, thinking: fullThinking || undefined });
                    });

                    res.on('error', (error: Error) => {
                        reject(error);
                    });
                } else {
                    let errorBody = '';
                    res.on('data', (chunk: Buffer) => {
                        errorBody += chunk.toString();
                    });
                    res.on('end', () => {
                        const errorMsg = res.statusCode === 404
                            ? `Endpoint not found. Make sure Ollama is running and the API endpoint is correct. (HTTP ${res.statusCode})`
                            : `HTTP ${res.statusCode}: ${res.statusMessage}${errorBody ? ' - ' + errorBody : ''}`;
                        reject(new Error(errorMsg));
                    });
                }
            });

            request.on('error', (error: Error) => {
                if (!isAborted) {
                    reject(new Error(`Cannot connect to Ollama. Make sure Ollama is running locally. ${error.message}`));
                }
            });

            request.write(requestBody);
            request.end();
        });

        return {
            promise,
            abort: () => {
                isAborted = true;
                if (request) {
                    request.destroy();
                }
                promise.catch(() => { });
            }
        };
    }
}
