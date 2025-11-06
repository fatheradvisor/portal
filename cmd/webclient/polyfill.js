(function () {
    'use strict';

    const currentScript = document.currentScript;
    const NativeWebSocket = window.WebSocket;

    const WS_PROTOTYPE = NativeWebSocket.prototype;
    const CONNECTING = NativeWebSocket.CONNECTING;
    const OPEN = NativeWebSocket.OPEN;
    const CLOSING = NativeWebSocket.CLOSING;
    const CLOSED = NativeWebSocket.CLOSED;

    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder('utf-8');

    function isSameOrigin(url) {
        try {
            const wsUrl = new URL(url, window.location.href);
            const currentOrigin = window.location.origin;
            let wsOrigin = wsUrl.origin;
            if (wsUrl.protocol === 'ws:') {
                wsOrigin = wsOrigin.replace('ws:', 'http:');
            } else if (wsUrl.protocol === 'wss:') {
                wsOrigin = wsOrigin.replace('wss:', 'https:');
            }
            return wsOrigin === currentOrigin;
        } catch (err) {
            return false;
        }
    }

    function defineEventHandler(target, handlers, type) {
        Object.defineProperty(target, 'on' + type, {
            configurable: true,
            enumerable: true,
            get() {
                return handlers[type] || null;
            },
            set(fn) {
                handlers[type] = typeof fn === 'function' ? fn : null;
            },
        });
    }

    function calculateSize(data) {
        if (typeof data === 'string') {
            return textEncoder.encode(data).length;
        }
        if (data instanceof ArrayBuffer) {
            return data.byteLength;
        }
        if (ArrayBuffer.isView(data)) {
            return data.byteLength;
        }
        if (data instanceof Blob) {
            return data.size;
        }
        return 0;
    }

    function encodeBinary(bytes) {
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.subarray(i, i + chunkSize);
            binary += String.fromCharCode.apply(null, chunk);
        }
        return btoa(binary);
    }

    function createCloseEvent(code, reason, wasClean) {
        try {
            return new CloseEvent('close', { code, reason, wasClean });
        } catch (err) {
            const event = document.createEvent('CloseEvent');
            event.initCloseEvent('close', false, false, reason, code);
            Object.defineProperty(event, 'wasClean', {
                configurable: true,
                enumerable: true,
                get() {
                    return wasClean;
                },
            });
            return event;
        }
    }

    function createErrorEvent(error) {
        const event = new Event('error');
        event.error = error;
        return event;
    }

    function emit(target, listenersMap, handlers, event) {
        const listeners = listenersMap.get(event.type);
        if (listeners) {
            for (const listener of Array.from(listeners)) {
                try {
                    listener.call(target, event);
                } catch (err) {
                    console.error('[WebSocket Polyfill] Listener error:', err);
                }
            }
        }

        const handler = handlers[event.type];
        if (handler) {
            try {
                handler.call(target, event);
            } catch (err) {
                console.error('[WebSocket Polyfill] Handler error:', err);
            }
        }

        return true;
    }

    function createHttpBridgeWebSocket(url, protocols) {
        const socket = Object.create(NativeWebSocket.prototype);

        let readyState = CONNECTING;
        let binaryType = 'blob';
        let protocol = '';
        let connId = null;
        let isClosed = false;
        let isSending = false;
        let bufferedAmount = 0;
        const listeners = new Map();
        const handlers = Object.create(null);
        const sendQueue = [];

        defineEventHandler(socket, handlers, 'open');
        defineEventHandler(socket, handlers, 'message');
        defineEventHandler(socket, handlers, 'error');
        defineEventHandler(socket, handlers, 'close');

        Object.defineProperties(socket, {
            url: {
                configurable: false,
                enumerable: true,
                writable: false,
                value: url,
            },
            readyState: {
                configurable: true,
                enumerable: true,
                get() {
                    return readyState;
                },
            },
            bufferedAmount: {
                configurable: true,
                enumerable: true,
                get() {
                    return bufferedAmount;
                },
            },
            extensions: {
                configurable: true,
                enumerable: true,
                writable: false,
                value: '',
            },
            protocol: {
                configurable: true,
                enumerable: true,
                get() {
                    return protocol;
                },
            },
            binaryType: {
                configurable: true,
                enumerable: true,
                get() {
                    return binaryType;
                },
                set(value) {
                    if (value === 'arraybuffer') {
                        binaryType = 'arraybuffer';
                    } else {
                        binaryType = 'blob';
                    }
                },
            },
        });

        socket.addEventListener = function (type, listener) {
            if (typeof listener !== 'function') {
                return;
            }
            if (!listeners.has(type)) {
                listeners.set(type, new Set());
            }
            listeners.get(type).add(listener);
        };

        socket.removeEventListener = function (type, listener) {
            const set = listeners.get(type);
            if (!set) {
                return;
            }
            set.delete(listener);
            if (set.size === 0) {
                listeners.delete(type);
            }
        };

        socket.dispatchEvent = function (event) {
            return emit(socket, listeners, handlers, event);
        };

        function changeState(state) {
            readyState = state;
        }

        function queueSend(rawData) {
            if (readyState !== OPEN) {
                throw new Error('WebSocket is not open');
            }
            const size = calculateSize(rawData);
            sendQueue.push({ rawData, size });
            bufferedAmount += size;
            flushQueue();
        }

        function flushQueue() {
            if (isSending || sendQueue.length === 0 || isClosed) {
                return;
            }
            isSending = true;
            (async () => {
                while (sendQueue.length > 0 && !isClosed) {
                    const { rawData, size } = sendQueue[0];
                    try {
                        let payload;
                        if (typeof rawData === 'string') {
                            payload = JSON.stringify({ type: 'text', data: rawData });
                        } else if (rawData instanceof Blob) {
                            const arrayBuffer = await rawData.arrayBuffer();
                            payload = JSON.stringify({
                                type: 'binary',
                                data: encodeBinary(new Uint8Array(arrayBuffer)),
                            });
                        } else if (rawData instanceof ArrayBuffer) {
                            payload = JSON.stringify({
                                type: 'binary',
                                data: encodeBinary(new Uint8Array(rawData)),
                            });
                        } else if (ArrayBuffer.isView(rawData)) {
                            payload = JSON.stringify({
                                type: 'binary',
                                data: encodeBinary(new Uint8Array(rawData.buffer, rawData.byteOffset, rawData.byteLength)),
                            });
                        } else {
                            throw new Error('Unsupported data type');
                        }

                        const response = await fetch(`/sw-cgi/websocket/send/${connId}`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: payload,
                        });

                        if (!response.ok) {
                            throw new Error(`Send failed: ${response.status}`);
                        }

                        sendQueue.shift();
                        bufferedAmount -= size;
                        if (bufferedAmount < 0) {
                            bufferedAmount = 0;
                        }
                    } catch (err) {
                        console.error('[WebSocket Polyfill] Failed to send message:', err);
                        handleError(err);
                        break;
                    }
                }
                isSending = false;
            })();
        }

        function handleOpen(negotiatedProtocol) {
            protocol = negotiatedProtocol || '';
            changeState(OPEN);
            emit(socket, listeners, handlers, new Event('open'));
        }

        function decodeMessage(message) {
            const binary = atob(message.data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            if (message.messageType === 'text') {
                return textDecoder.decode(bytes);
            }
            if (binaryType === 'arraybuffer') {
                return bytes.buffer;
            }
            return new Blob([bytes]);
        }

        function handleMessage(message) {
            if (readyState !== OPEN) {
                return;
            }
            if (message.type === 'close') {
                handleClose(message.code || 1000, message.reason || '', message.code === 1000);
                return;
            }
            let data;
            try {
                data = decodeMessage(message);
            } catch (err) {
                console.error('[WebSocket Polyfill] Failed to decode message:', err);
                return;
            }
            let origin = '';
            try {
                origin = new URL(url, window.location.href).origin;
            } catch (err) {
                origin = window.location.origin;
            }
            const event = new MessageEvent('message', {
                data,
                origin,
            });
            emit(socket, listeners, handlers, event);
        }

        function handleError(error) {
            if (isClosed) {
                return;
            }
            const event = createErrorEvent(error);
            emit(socket, listeners, handlers, event);
            handleClose(1006, error && error.message ? error.message : 'Unexpected error', false);
        }

        function handleClose(code, reason, wasClean) {
            if (isClosed) {
                return;
            }
            isClosed = true;
            changeState(CLOSED);
            const event = createCloseEvent(code, reason, wasClean);
            emit(socket, listeners, handlers, event);
        }

        function startPolling() {
            (async () => {
                while (!isClosed) {
                    try {
                        const response = await fetch(`/sw-cgi/websocket/poll/${connId}`, {
                            method: 'GET',
                        });
                        if (!response.ok) {
                            throw new Error(`Poll failed: ${response.status}`);
                        }
                        const result = await response.json();
                        const messages = Array.isArray(result.messages) ? result.messages : [];
                        for (const message of messages) {
                            handleMessage(message);
                        }
                    } catch (err) {
                        if (!isClosed) {
                            console.error('[WebSocket Polyfill] Polling error:', err);
                            handleError(err);
                        }
                        break;
                    }
                }
            })();
        }

        socket.send = function (data) {
            queueSend(data);
        };

        socket.close = function (code = 1000, reason = '') {
            if (isClosed || readyState === CLOSING) {
                return;
            }
            changeState(CLOSING);
            (async () => {
                if (connId) {
                    try {
                        await fetch(`/sw-cgi/websocket/send/${connId}`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({ type: 'close', code, reason }),
                        });
                    } catch (err) {
                        console.error('[WebSocket Polyfill] Failed to send close frame:', err);
                    }
                }
                handleClose(code, reason, code === 1000);
            })();
        };

        (async () => {
            try {
                const response = await fetch('/sw-cgi/websocket/connect', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        url,
                        protocols: Array.isArray(protocols) ? protocols : protocols ? [protocols] : [],
                    }),
                });
                if (!response.ok) {
                    throw new Error(`Connection failed: ${response.status} ${response.statusText}`);
                }
                const result = await response.json();
                connId = result.connId;
                handleOpen(result.protocol);
                startPolling();
            } catch (err) {
                handleError(err);
            }
        })();

        return socket;
    }

    window.WebSocket = function (url, protocols) {
        if (isSameOrigin(url)) {
            console.log('[WebSocket Polyfill] Using HTTP bridge for same-origin connection:', url);
            return createHttpBridgeWebSocket(url, protocols);
        }
        console.log('[WebSocket Polyfill] Using native WebSocket for cross-origin connection:', url);
        return new NativeWebSocket(url, protocols);
    };

    window.WebSocket.prototype = WS_PROTOTYPE;
    window.WebSocket.CONNECTING = CONNECTING;
    window.WebSocket.OPEN = OPEN;
    window.WebSocket.CLOSING = CLOSING;
    window.WebSocket.CLOSED = CLOSED;

    if ('WebSocketPair' in NativeWebSocket) {
        window.WebSocket.WebSocketPair = NativeWebSocket.WebSocketPair;
    }

    console.log('[WebSocket Polyfill] Initialized');

    if (currentScript && currentScript.parentNode) {
        currentScript.parentNode.removeChild(currentScript);
        console.log('[WebSocket Polyfill] Script tag removed');
    }
})();