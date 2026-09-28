// ==UserScript==
// @name         Apple Music 下载助手
// @namespace    http://tampermonkey.net/
// @version      0.2
// @author       @sky82813
// @description  在 Apple Music 官网直接下载音视频
// @match        https://music.apple.com/*
// @match        https://beta.music.apple.com/*
// @match        https://classical.music.apple.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        unsafeWindow
// @connect      t.kimu.edu.kg
// @connect      apple.com
// @connect      itunes.apple.com
// @connect      mzstatic.com
// @connect      *
// ==/UserScript==

(function() {
    'use strict';

    const SERVER_URL = 'https://t.kimu.edu.kg';
    
    const END_CHAR = String.fromCharCode(36);
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const gmXhr = (typeof GM_xmlhttpRequest === 'function')
        ? GM_xmlhttpRequest
        : (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function' ? GM.xmlHttpRequest : null);

    function resolveBackendUrl(rawUrl) {
        const u = String(rawUrl || '');
        if (!u || u.startsWith('blob:') || u.startsWith('data:')) return u;
        if (u.startsWith(SERVER_URL)) return u;

        if (u.startsWith('/proxy') || u.startsWith('/key') || u.startsWith('/api/') || u.startsWith('/mv/') || u.startsWith('/parse/') || u.startsWith('/assets/')) {
            return SERVER_URL + u;
        }

        try {
            const parsed = new URL(u, pageWindow.location.href);
            const isApplePageHost = parsed.hostname.endsWith('music.apple.com');
            if (isApplePageHost) {
                const p = parsed.pathname;
                if (p.startsWith('/proxy') || p.startsWith('/key') || p.startsWith('/api/') || p.startsWith('/mv/') || p.startsWith('/parse/') || p.startsWith('/assets/')) {
                    return SERVER_URL + p + parsed.search;
                }
                const isAppleOwnBundle = p.includes('~') || p.includes('musickit') || p.includes('/includes/') || p.includes('/build/');
                if (!isAppleOwnBundle && (p.endsWith('.js') || p.endsWith('.mjs') || p.endsWith('.wasm'))) {
                    const fileName = p.split('/').pop();
                    return SERVER_URL + '/assets/' + fileName + parsed.search;
                }
            }
        } catch (e) {}

        if (!u.startsWith('http') && !u.startsWith('/')) {
            return SERVER_URL + '/assets/' + u;
        }
        return u;
    }

    function shouldProxyUrl(rawUrl) {
        const u = String(rawUrl || '');
        if (!u || u.startsWith('blob:') || u.startsWith('data:')) return false;
        const resolved = resolveBackendUrl(u);
        if (resolved.startsWith(SERVER_URL)) return true;
        if (resolved.includes('itunes.apple.com') || resolved.includes('mzstatic.com') || resolved.includes('ak1ra.de5.net')) {
            return true;
        }
        if (resolved.includes('cdn.jsdelivr.net/npm/') || resolved.includes('unpkg.com/')) {
            return true;
        }
        return false;
    }

    function guessMimeType(urlStr) {
        const clean = String(urlStr).split('?')[0].toLowerCase();
        if (clean.endsWith('.wasm')) return 'application/wasm';
        if (clean.endsWith('.js') || clean.endsWith('.mjs')) return 'application/javascript; charset=utf-8';
        if (clean.endsWith('.json') || clean.includes('/api/') || clean.includes('/key')) return 'application/json; charset=utf-8';
        if (clean.endsWith('.m3u8') || clean.includes('/proxy/')) return 'application/vnd.apple.mpegurl';
        return 'application/octet-stream';
    }

    function gmFetchRaw(url, options) {
        const opts = options || {};
        const fullUrl = resolveBackendUrl(url);
        return new Promise(function(resolve, reject) {
            if (!gmXhr) {
                reject(new Error('油猴未授予 GM_xmlhttpRequest 权限'));
                return;
            }
            gmXhr({
                method: opts.method || 'GET',
                url: fullUrl,
                headers: opts.headers || {},
                data: opts.body || undefined,
                responseType: opts.responseType || 'text',
                timeout: opts.timeout || 60000,
                onload: function(resp) {
                    if (resp.status === 404 && fullUrl.startsWith(SERVER_URL + '/assets/') && !fullUrl.startsWith(SERVER_URL + '/assets/mv/')) {
                        const fileName = fullUrl.slice((SERVER_URL + '/assets/').length);
                        const mvAltUrl = SERVER_URL + '/assets/mv/' + fileName;
                        gmXhr({
                            method: opts.method || 'GET',
                            url: mvAltUrl,
                            headers: opts.headers || {},
                            data: opts.body || undefined,
                            responseType: opts.responseType || 'text',
                            timeout: opts.timeout || 60000,
                            onload: resolve,
                            onerror: function() { resolve(resp); },
                            ontimeout: function() { resolve(resp); }
                        });
                        return;
                    }
                    resolve(resp);
                },
                onerror: function() {
                    reject(new Error('网络请求失败: ' + fullUrl));
                },
                ontimeout: function() {
                    reject(new Error('请求超时: ' + fullUrl));
                }
            });
        });
    }

    async function gmFetchJson(url) {
        const resp = await gmFetchRaw(url, { responseType: 'text' });
        if (resp.status !== 200) {
            throw new Error('HTTP ' + resp.status + ': ' + (resp.responseText || ''));
        }
        return JSON.parse(resp.responseText);
    }

    async function createVirtualSyncAccessHandle(fileHandle) {
        if ((!fileHandle.__am_mem_buf || fileHandle.__am_mem_buf.byteLength === 0) && fileHandle.__am_is_real_disk && typeof fileHandle.getFile === 'function') {
            try {
                const diskFile = await fileHandle.getFile();
                if (diskFile && diskFile.size !== 0) {
                    const ab = await diskFile.arrayBuffer();
                    fileHandle.__am_mem_buf = new Uint8Array(ab);
                }
            } catch (e) {}
        }

        let buf = new Uint8Array(fileHandle.__am_mem_buf ? fileHandle.__am_mem_buf : 0);
        let len = buf.byteLength;
        let cursor = 0;

        function ensureCap(requiredLen) {
            if (Math.max(requiredLen, buf.byteLength) === buf.byteLength) return;
            let newCap = Math.max(buf.byteLength * 2, requiredLen, 65536);
            const nextBuf = new Uint8Array(newCap);
            nextBuf.set(buf.subarray(0, len), 0);
            buf = nextBuf;
        }

        const syncHandle = {
            getSize: function() {
                return len;
            },
            truncate: function(newSize) {
                const sz = Math.max(0, Number(newSize) || 0);
                ensureCap(sz);
                if (Math.max(sz, len) === sz) {
                    buf.fill(0, len, sz);
                }
                len = sz;
                if (Math.max(cursor, len) === cursor) cursor = len;
                fileHandle.__am_mem_buf = buf.subarray(0, len);
            },
            read: function(targetBuffer, options) {
                const at = (options && typeof options.at === 'number') ? Math.max(0, options.at) : cursor;
                if (Math.max(at, len) === at) return 0;
                const view = ArrayBuffer.isView(targetBuffer)
                    ? new Uint8Array(targetBuffer.buffer, targetBuffer.byteOffset, targetBuffer.byteLength)
                    : new Uint8Array(targetBuffer);
                const avail = Math.max(0, len - at);
                const toRead = Math.min(view.byteLength, avail);
                if (toRead !== 0) {
                    view.set(buf.subarray(at, at + toRead), 0);
                }
                cursor = at + toRead;
                return toRead;
            },
            write: function(sourceBuffer, options) {
                const at = (options && typeof options.at === 'number') ? Math.max(0, options.at) : cursor;
                const view = ArrayBuffer.isView(sourceBuffer)
                    ? new Uint8Array(sourceBuffer.buffer, sourceBuffer.byteOffset, sourceBuffer.byteLength)
                    : new Uint8Array(sourceBuffer);
                const endPos = at + view.byteLength;
                ensureCap(endPos);
                buf.set(view, at);
                if (Math.max(endPos, len) === endPos) {
                    len = endPos;
                }
                cursor = endPos;
                fileHandle.__am_mem_buf = buf.subarray(0, len);
                return view.byteLength;
            },
            flush: function() {
                fileHandle.__am_mem_buf = buf.subarray(0, len);
            },
            close: function() {
                fileHandle.__am_mem_buf = buf.subarray(0, len);
                if (fileHandle.__am_is_real_disk && typeof fileHandle.createWritable === 'function' && len !== 0) {
                    fileHandle.__am_flush_promise = (async function() {
                        const w = await fileHandle.createWritable();
                        await w.write(fileHandle.__am_mem_buf);
                        await w.close();
                        delete fileHandle.__am_mem_buf;
                    })();
                    if (!pageWindow.__am_flushes) pageWindow.__am_flushes = [];
                    pageWindow.__am_flushes.push(fileHandle.__am_flush_promise);
                }
            }
        };
        return syncHandle;
    }

    function createVirtualOpfsRoot() {
        const filesMap = new Map();
        const dirsMap = new Map();

        function makeFileHandle(name) {
            const fh = {
                kind: 'file',
                name: name,
                __am_mem_buf: new Uint8Array(0),
                createSyncAccessHandle: async function() {
                    return createVirtualSyncAccessHandle(fh);
                },
                getFile: async function() {
                    const data = fh.__am_mem_buf || new Uint8Array(0);
                    return new File([data], name, { type: 'application/octet-stream' });
                },
                createWritable: async function() {
                    const chunks = [];
                    let cursor = 0;
                    return {
                        write: async function(chunk) {
                            let bytes = chunk;
                            if (chunk && typeof chunk === 'object' && chunk.type === 'write' && chunk.data) {
                                if (typeof chunk.position === 'number') cursor = chunk.position;
                                bytes = chunk.data;
                            }
                            if (bytes instanceof Blob) {
                                bytes = new Uint8Array(await bytes.arrayBuffer());
                            } else if (ArrayBuffer.isView(bytes)) {
                                bytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                            } else if (bytes instanceof ArrayBuffer) {
                                bytes = new Uint8Array(bytes);
                            }
                            chunks.push({ pos: cursor, data: bytes });
                            cursor += bytes.byteLength;
                        },
                        seek: async function(pos) { cursor = pos; },
                        close: async function() {
                            let maxEnd = fh.__am_mem_buf ? fh.__am_mem_buf.byteLength : 0;
                            chunks.forEach(function(c) {
                                if (Math.max(c.pos + c.data.byteLength, maxEnd) === c.pos + c.data.byteLength) {
                                    maxEnd = c.pos + c.data.byteLength;
                                }
                            });
                            const out = new Uint8Array(maxEnd);
                            if (fh.__am_mem_buf && fh.__am_mem_buf.byteLength !== 0) {
                                out.set(fh.__am_mem_buf, 0);
                            }
                            chunks.forEach(function(c) { out.set(c.data, c.pos); });
                            fh.__am_mem_buf = out;
                        }
                    };
                }
            };
            return fh;
        }

        const dirObj = {
            kind: 'directory',
            name: 'opfs-root',
            getFileHandle: async function(name) {
                if (!filesMap.has(name)) filesMap.set(name, makeFileHandle(name));
                return filesMap.get(name);
            },
            getDirectoryHandle: async function(name) {
                if (!dirsMap.has(name)) dirsMap.set(name, createVirtualOpfsRoot());
                return dirsMap.get(name);
            },
            removeEntry: async function(name) {
                filesMap.delete(name);
                dirsMap.delete(name);
            }
        };
        return dirObj;
    }

    const globalVirtualOpfs = createVirtualOpfsRoot();

    function installNetworkAndWorkerHooks() {
        if (pageWindow.__am_net_hooked) return;
        pageWindow.__am_net_hooked = true;
        if (pageWindow.FileSystemFileHandle) {
            pageWindow.FileSystemFileHandle.prototype.createSyncAccessHandle = async function() {
                this.__am_is_real_disk = true;
                return await createVirtualSyncAccessHandle(this);
            };
        }
        if (window.FileSystemFileHandle) {
            window.FileSystemFileHandle.prototype.createSyncAccessHandle = async function() {
                this.__am_is_real_disk = true;
                return await createVirtualSyncAccessHandle(this);
            };
        }

        if (typeof pageWindow.WebAssembly !== 'undefined') {
            const origInstStream = pageWindow.WebAssembly.instantiateStreaming;
            pageWindow.WebAssembly.instantiateStreaming = async function(source, importObject) {
                try {
                    const resp = await source;
                    const buf = await resp.arrayBuffer();
                    return await pageWindow.WebAssembly.instantiate(buf, importObject);
                } catch (e) {
                    return origInstStream.call(pageWindow.WebAssembly, source, importObject);
                }
            };
        }

        const origFetch = pageWindow.fetch.bind(pageWindow);
        pageWindow.fetch = async function(input, init) {
            const isReqObj = input && typeof input === 'object' && typeof input.url === 'string';
            const urlStr = typeof input === 'string' ? input : (isReqObj ? input.url : String(input));
            if (urlStr.startsWith('blob:') && pageWindow.__am_blob_store && pageWindow.__am_blob_store.has(urlStr)) {
                const storedBlob = pageWindow.__am_blob_store.get(urlStr);
                const buf = await storedBlob.arrayBuffer();
                return new Response(buf, {
                    status: 200,
                    headers: { 'Content-Type': storedBlob.type || 'application/octet-stream' }
                });
            }
            if (shouldProxyUrl(urlStr)) {
                const targetUrl = resolveBackendUrl(urlStr);
                const reqHeaders = {};
                function copyHdrs(hSource) {
                    if (!hSource) return;
                    if (typeof hSource.forEach === 'function') {
                        hSource.forEach(function(v, k) { reqHeaders[k] = v; });
                    } else if (Array.isArray(hSource)) {
                        hSource.forEach(function(pair) { if (pair && pair.length >= 2) reqHeaders[pair[0]] = pair[1]; });
                    } else if (typeof hSource === 'object') {
                        Object.assign(reqHeaders, hSource);
                    }
                }
                if (isReqObj && input.headers) copyHdrs(input.headers);
                if (init && init.headers) copyHdrs(init.headers);

                const reqMethod = (init && init.method) || (isReqObj && input.method) || 'GET';
                let reqBody = init && init.body;
                if (reqBody === undefined && isReqObj && reqMethod !== 'GET' && reqMethod !== 'HEAD' && typeof input.clone === 'function') {
                    try { reqBody = await input.clone().text(); } catch (e) {}
                }

                const resp = await gmFetchRaw(targetUrl, {
                    method: reqMethod,
                    headers: reqHeaders,
                    body: reqBody,
                    responseType: 'arraybuffer',
                    timeout: 300000
                });
                return new Response(resp.response, {
                    status: resp.status || 200,
                    headers: { 'Content-Type': guessMimeType(targetUrl) }
                });
            }
            return origFetch(input, init);
        };

        const OrigXHR = pageWindow.XMLHttpRequest;
        function PatchedXHR() {
            const xhr = new OrigXHR();
            let interceptUrl = null;
            let reqMethod = 'GET';
            const reqHeaders = {};

            const origOpen = xhr.open.bind(xhr);
            xhr.open = function(method, url) {
                const uStr = String(url);
                if (shouldProxyUrl(uStr)) {
                    reqMethod = method || 'GET';
                    interceptUrl = resolveBackendUrl(uStr);
                } else {
                    interceptUrl = null;
                }
                return origOpen.apply(xhr, arguments);
            };

            const origSetHeader = xhr.setRequestHeader.bind(xhr);
            xhr.setRequestHeader = function(k, v) {
                reqHeaders[k] = v;
                return origSetHeader.apply(xhr, arguments);
            };

            const origSend = xhr.send.bind(xhr);
            xhr.send = function(body) {
                if (!interceptUrl) {
                    return origSend.apply(xhr, arguments);
                }
                const wantBuffer = xhr.responseType === 'arraybuffer' || xhr.responseType === 'blob';
                gmFetchRaw(interceptUrl, {
                    method: reqMethod,
                    headers: reqHeaders,
                    body: body,
                    responseType: wantBuffer ? 'arraybuffer' : 'text'
                }).then(function(resp) {
                    Object.defineProperty(xhr, 'readyState', { value: 4, configurable: true });
                    Object.defineProperty(xhr, 'status', { value: resp.status || 200, configurable: true });
                    if (wantBuffer) {
                        const outVal = xhr.responseType === 'blob' ? new Blob([resp.response]) : resp.response;
                        Object.defineProperty(xhr, 'response', { value: outVal, configurable: true });
                    } else {
                        Object.defineProperty(xhr, 'responseText', { value: resp.responseText, configurable: true });
                        Object.defineProperty(xhr, 'response', { value: resp.responseText, configurable: true });
                    }
                    if (typeof xhr.onreadystatechange === 'function') xhr.onreadystatechange(new Event('readystatechange'));
                    if (typeof xhr.onload === 'function') xhr.onload(new ProgressEvent('load'));
                    xhr.dispatchEvent(new Event('readystatechange'));
                    xhr.dispatchEvent(new ProgressEvent('load'));
                    xhr.dispatchEvent(new ProgressEvent('loadend'));
                }).catch(function(err) {
                    if (typeof xhr.onerror === 'function') xhr.onerror(err);
                    xhr.dispatchEvent(new ProgressEvent('error'));
                });
            };
            return xhr;
        }
        pageWindow.XMLHttpRequest = PatchedXHR;
        window.XMLHttpRequest = PatchedXHR;

        const OrigWorker = pageWindow.Worker;
        function BridgedWorker(scriptUrl, options) {
            const uStr = (scriptUrl && scriptUrl.href) ? scriptUrl.href : String(scriptUrl || '');
            if (uStr.startsWith('blob:') && !(pageWindow.__am_blob_store && pageWindow.__am_blob_store.has(uStr))) {
                return new OrigWorker(scriptUrl, options);
            }

            const selfWrapper = this;
            this.onmessage = null;
            this.onerror = null;
            this._msgListeners = [];
            this._errListeners = [];
            this._queue = [];
            this._virtualSelf = null;
            this._terminated = false;

            async function initVirtualWorker() {
                let code = '';
                let baseModuleUrl = SERVER_URL + '/assets/mv/worker.mjs';

                if (uStr.startsWith('blob:')) {
                    const rawBlob = pageWindow.__am_blob_store && pageWindow.__am_blob_store.get(uStr);
                    if (!rawBlob) throw new Error('找不到 Blob Worker 脚本');
                    code = await rawBlob.text();
                } else {
                    const resolved = resolveBackendUrl(uStr);
                    baseModuleUrl = resolved;
                    const resp = await gmFetchRaw(resolved, { responseType: 'text' });
                    if (resp.status !== 200 || !resp.responseText) {
                        throw new Error('加载 Worker 脚本失败: ' + resolved + ' (HTTP ' + resp.status + ')');
                    }
                    code = resp.responseText;
                }

                if (selfWrapper._terminated) return;
                const workerScriptCache = {};
                const impScriptRe = /importScripts\s*\(([^)]+)\)/g;
                let impMatch;
                const urlsToPreload = [];
                while ((impMatch = impScriptRe.exec(code)) !== null) {
                    const strRe = /['"]([^'"]+)['"]/g;
                    let sMatch;
                    while ((sMatch = strRe.exec(impMatch[1])) !== null) {
                        urlsToPreload.push(sMatch[1]);
                    }
                }
                for (const rawDep of urlsToPreload) {
                    try {
                        const fullDepUrl = resolveBackendUrl(new URL(rawDep, baseModuleUrl).href);
                        const depResp = await gmFetchRaw(fullDepUrl, { responseType: 'text' });
                        if (depResp.status === 200 && depResp.responseText) {
                            workerScriptCache[rawDep] = depResp.responseText;
                            workerScriptCache[fullDepUrl] = depResp.responseText;
                            const shortName = fullDepUrl.split('/').pop().split('?')[0];
                            workerScriptCache[shortName] = depResp.responseText;
                        }
                    } catch (e) {}
                }

                const virtualSelf = {
                    onmessage: null,
                    onerror: null,
                    _msgListeners: [],
                    location: new URL(baseModuleUrl),
                    origin: SERVER_URL,
                    isSecureContext: true,
                    crossOriginIsolated: false,
                    navigator: Object.assign({}, pageWindow.navigator, {
                        userAgent: pageWindow.navigator.userAgent,
                        hardwareConcurrency: pageWindow.navigator.hardwareConcurrency || 4,
                        storage: pageWindow.navigator.storage || {
                            getDirectory: async function() {
                                return globalVirtualOpfs;
                            }
                        }
                    }),
                    crypto: pageWindow.crypto,
                    performance: pageWindow.performance,
                    indexedDB: pageWindow.indexedDB,
                    WebAssembly: pageWindow.WebAssembly,
                    XMLHttpRequest: pageWindow.XMLHttpRequest,
                    TextEncoder: pageWindow.TextEncoder,
                    TextDecoder: pageWindow.TextDecoder,
                    Uint8Array: Uint8Array,
                    Int8Array: Int8Array,
                    Uint16Array: Uint16Array,
                    Int16Array: Int16Array,
                    Uint32Array: Uint32Array,
                    Int32Array: Int32Array,
                    Float32Array: Float32Array,
                    Float64Array: Float64Array,
                    BigInt64Array: pageWindow.BigInt64Array,
                    BigUint64Array: pageWindow.BigUint64Array,
                    ArrayBuffer: ArrayBuffer,
                    DataView: DataView,
                    Blob: Blob,
                    URL: pageWindow.URL,
                    Response: Response,
                    Request: Request,
                    Headers: Headers,
                    AbortController: AbortController,
                    ReadableStream: pageWindow.ReadableStream,
                    WritableStream: pageWindow.WritableStream,
                    TransformStream: pageWindow.TransformStream,
                    setTimeout: setTimeout.bind(pageWindow),
                    clearTimeout: clearTimeout.bind(pageWindow),
                    setInterval: setInterval.bind(pageWindow),
                    clearInterval: clearInterval.bind(pageWindow),
                    queueMicrotask: queueMicrotask.bind(pageWindow),
                    atob: atob.bind(pageWindow),
                    btoa: btoa.bind(pageWindow),
                    console: console,
                    Math: Math,
                    JSON: JSON,
                    Date: Date,
                    Promise: Promise,
                    Error: Error,
                    TypeError: TypeError,
                    RangeError: RangeError,
                    Map: Map,
                    Set: Set,
                    WeakMap: WeakMap,
                    WeakSet: WeakSet,
                    Symbol: Symbol,
                    Object: Object,
                    Array: Array,
                    String: String,
                    Number: Number,
                    Boolean: Boolean,
                    RegExp: RegExp,
                    parseInt: parseInt,
                    parseFloat: parseFloat,
                    isNaN: isNaN,
                    isFinite: isFinite,
                    close: function() {
                        selfWrapper.terminate();
                    },
                    postMessage: function(data) {
                        if (selfWrapper._terminated) return;
                        const deliver = function() {
                            if (selfWrapper._terminated) return;
                            setTimeout(function() {
                                if (selfWrapper._terminated) return;
                                const evt = new MessageEvent('message', { data: data });
                                if (typeof selfWrapper.onmessage === 'function') {
                                    selfWrapper.onmessage(evt);
                                }
                                selfWrapper._msgListeners.slice().forEach(function(fn) {
                                    if (typeof fn === 'function') fn.call(selfWrapper, evt);
                                    else if (fn && typeof fn.handleEvent === 'function') fn.handleEvent(evt);
                                });
                            }, 0);
                        };
                        if (pageWindow.__am_flushes && pageWindow.__am_flushes.length !== 0) {
                            Promise.all(pageWindow.__am_flushes).then(function() {
                                pageWindow.__am_flushes = [];
                                deliver();
                            }).catch(function() {
                                pageWindow.__am_flushes = [];
                                deliver();
                            });
                        } else {
                            deliver();
                        }
                    },
                    addEventListener: function(type, listener) {
                        if (type === 'message' && !virtualSelf._msgListeners.includes(listener)) {
                            virtualSelf._msgListeners.push(listener);
                        }
                    },
                    removeEventListener: function(type, listener) {
                        if (type === 'message') {
                            const idx = virtualSelf._msgListeners.indexOf(listener);
                            if (idx !== -1) virtualSelf._msgListeners.splice(idx, 1);
                        }
                    },
                    fetch: function(input, init) {
                        let reqUrl = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
                        if (!reqUrl.startsWith('http') && !reqUrl.startsWith('blob:') && !reqUrl.startsWith('data:')) {
                            reqUrl = new URL(reqUrl, baseModuleUrl).href;
                        }
                        return pageWindow.fetch(reqUrl, init);
                    },
                    importScripts: function() {
                        for (let i = 0; i !== arguments.length; i++) {
                            const rawU = String(arguments[i] || '');
                            const fullU = resolveBackendUrl(new URL(rawU, baseModuleUrl).href);
                            const shortU = fullU.split('/').pop().split('?')[0];
                            const cachedCode = workerScriptCache[rawU] || workerScriptCache[fullU] || workerScriptCache[shortU];
                            if (cachedCode) {
                                const fn = new Function('self', 'globalThis', 'window', 'with (self) {\n' + cachedCode + '\n}');
                                fn.call(virtualSelf, virtualSelf, virtualSelf, virtualSelf);
                                if (virtualSelf.Go) {
                                    pageWindow.Go = virtualSelf.Go;
                                    window.Go = virtualSelf.Go;
                                }
                            } else {
                                console.warn('[AM Helper] importScripts 未命中预缓存:', rawU);
                            }
                        }
                    }
                };
                virtualSelf.self = virtualSelf;
                virtualSelf.globalThis = virtualSelf;
                virtualSelf.window = virtualSelf;
                virtualSelf.__asyncImportScripts = async function() {
                    for (let i = 0; i !== arguments.length; i++) {
                        const rawU = String(arguments[i] || '');
                        const fullU = resolveBackendUrl(new URL(rawU, baseModuleUrl).href);
                        const shortU = fullU.split('/').pop().split('?')[0];
                        let jsText = workerScriptCache[rawU] || workerScriptCache[fullU] || workerScriptCache[shortU];
                        if (!jsText) {
                            const r = await gmFetchRaw(fullU, { responseType: 'text' });
                            if (r.status === 200 && r.responseText) {
                                jsText = r.responseText;
                                workerScriptCache[fullU] = jsText;
                            }
                        }
                        if (jsText) {
                            const fn = new Function('self', 'globalThis', 'window', 'with (self) {\n' + jsText + '\n}');
                            fn.call(virtualSelf, virtualSelf, virtualSelf, virtualSelf);
                            if (virtualSelf.Go) {
                                pageWindow.Go = virtualSelf.Go;
                                window.Go = virtualSelf.Go;
                            }
                        }
                    }
                };

                await evalEsmModuleAsync(code, baseModuleUrl, {}, virtualSelf);
                selfWrapper._virtualSelf = virtualSelf;

                while (selfWrapper._queue.length !== 0) {
                    const item = selfWrapper._queue.shift();
                    selfWrapper._deliverToVirtual(item.data);
                }
            }

            initVirtualWorker().catch(function(err) {
                console.error('[AM Helper] 虚拟 Worker 初始化失败:', err);
                const errEvt = new ErrorEvent('error', { message: err.message || String(err), error: err });
                if (typeof selfWrapper.onerror === 'function') selfWrapper.onerror(errEvt);
                selfWrapper._errListeners.slice().forEach(function(fn) {
                    if (typeof fn === 'function') fn.call(selfWrapper, errEvt);
                });
            });
        }

        BridgedWorker.prototype._deliverToVirtual = function(data) {
            const vSelf = this._virtualSelf;
            if (!vSelf || this._terminated) return;
            setTimeout(function() {
                const evt = new MessageEvent('message', { data: data });
                if (typeof vSelf.__dispatchToWorker === 'function') {
                    vSelf.__dispatchToWorker(evt);
                } else {
                    if (typeof vSelf.onmessage === 'function') vSelf.onmessage(evt);
                    vSelf._msgListeners.slice().forEach(function(fn) {
                        if (typeof fn === 'function') fn.call(vSelf, evt);
                        else if (fn && typeof fn.handleEvent === 'function') fn.handleEvent(evt);
                    });
                }
            }, 0);
        };

        BridgedWorker.prototype.postMessage = function(data, transfer) {
            if (this._terminated) return;
            if (this._virtualSelf) {
                this._deliverToVirtual(data);
            } else {
                this._queue.push({ data: data, transfer: transfer });
            }
        };

        BridgedWorker.prototype.terminate = function() {
            this._terminated = true;
            this._queue = [];
            this._virtualSelf = null;
        };

        BridgedWorker.prototype.addEventListener = function(type, listener) {
            if (type === 'message') {
                if (!this._msgListeners.includes(listener)) this._msgListeners.push(listener);
            } else if (type === 'error') {
                if (!this._errListeners.includes(listener)) this._errListeners.push(listener);
            }
        };

        BridgedWorker.prototype.removeEventListener = function(type, listener) {
            if (type === 'message') {
                const idx = this._msgListeners.indexOf(listener);
                if (idx !== -1) this._msgListeners.splice(idx, 1);
            } else if (type === 'error') {
                const idx = this._errListeners.indexOf(listener);
                if (idx !== -1) this._errListeners.splice(idx, 1);
            }
        };

        pageWindow.Worker = BridgedWorker;
        window.Worker = BridgedWorker;
    }

    let decryptLoadedPromise = null;
    function ensureAmDecryptLoaded() {
        if (pageWindow.AmDecrypt || window.AmDecrypt) return Promise.resolve();
        if (decryptLoadedPromise) return decryptLoadedPromise;

        installNetworkAndWorkerHooks();
        decryptLoadedPromise = gmFetchRaw('/assets/decrypt.js', { responseType: 'text' }).then(function(resp) {
            if (resp.status !== 200 || !resp.responseText) {
                throw new Error('加载 /assets/decrypt.js 失败 (HTTP ' + resp.status + ')');
            }
            try {
                Object.defineProperty(document, 'currentScript', {
                    value: { src: SERVER_URL + '/assets/decrypt.js' },
                    configurable: true
                });
            } catch (e) {}

            const runScript = new Function('window', 'self', 'globalThis', resp.responseText);
            runScript(pageWindow, pageWindow, pageWindow);
            if (!window.AmDecrypt && pageWindow.AmDecrypt) {
                window.AmDecrypt = pageWindow.AmDecrypt;
            }
        }).catch(function(err) {
            decryptLoadedPromise = null;
            throw err;
        });
        return decryptLoadedPromise;
    }

    let ffmpegCoreLoaded = false;
    async function getFFmpegInstance() {
        installNetworkAndWorkerHooks();
        installBlobClickHook();
        if (!pageWindow.FFmpeg && !window.FFmpeg) {
            const ffUrl = 'https://cdn.jsdelivr.net/npm/' + '@ffmpeg/ffmpeg' + '@0.11.6/dist/ffmpeg.min.js';
            const ffResp = await gmFetchRaw(ffUrl, { responseType: 'text' });
            if (ffResp.status !== 200 || !ffResp.responseText) {
                throw new Error('加载 ffmpeg.min.js 失败');
            }
            const runFF = new Function('window', 'self', 'globalThis', ffResp.responseText);
            runFF(pageWindow, pageWindow, pageWindow);
            if (!window.FFmpeg && pageWindow.FFmpeg) {
                window.FFmpeg = pageWindow.FFmpeg;
            }
        }

        const baseCore = 'https://cdn.jsdelivr.net/npm/' + '@ffmpeg/core-st' + '@0.11.1/dist/';
        if (!ffmpegCoreLoaded || !pageWindow.createFFmpegCore) {
            const coreJsResp = await gmFetchRaw(baseCore + 'ffmpeg-core.js', { responseType: 'text' });
            if (coreJsResp.status !== 200 || !coreJsResp.responseText) {
                throw new Error('加载 ffmpeg-core.js 失败');
            }
            const corePatch = '\n;window.createFFmpegCore = typeof createFFmpegCore !== "undefined" ? createFFmpegCore : self.createFFmpegCore;';
            const runCore = new Function('window', 'self', 'globalThis', coreJsResp.responseText + corePatch);
            runCore(pageWindow, pageWindow, pageWindow);
            if (!window.createFFmpegCore && pageWindow.createFFmpegCore) {
                window.createFFmpegCore = pageWindow.createFFmpegCore;
            }
            ffmpegCoreLoaded = true;
        }

        const FFmpegLib = pageWindow.FFmpeg || window.FFmpeg;
        const ff = FFmpegLib.createFFmpeg({
            log: false,
            mainName: 'main',
            corePath: baseCore + 'ffmpeg-core.js',
            wasmPath: baseCore + 'ffmpeg-core.wasm'
        });
        await ff.load();
        return ff;
    }

    const esmModuleCache = {};
    async function loadEsmModuleByUrl(moduleUrl) {
        const fullUrl = resolveBackendUrl(moduleUrl);
        if (esmModuleCache[fullUrl]) return esmModuleCache[fullUrl];
        const resp = await gmFetchRaw(fullUrl, { responseType: 'text' });
        if (resp.status !== 200 || !resp.responseText) {
            throw new Error('加载模块失败: ' + fullUrl + ' (HTTP ' + resp.status + ')');
        }
        const mod = await evalEsmModuleAsync(resp.responseText, fullUrl, {}, null);
        esmModuleCache[fullUrl] = mod;
        return mod;
    }

    async function evalEsmModuleAsync(codeStr, moduleUrl, extraScope, workerContext) {
        const exportsObj = {};
        const scopeObj = Object.assign({}, extraScope || {});
        let transformed = String(codeStr);
        transformed = transformed.replace(/import\.meta\.url/g, JSON.stringify(moduleUrl || (SERVER_URL + '/assets/mv/engine.mjs')));
        const importRegex = /^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
        const importMatches = [];
        let m;
        while ((m = importRegex.exec(transformed)) !== null) {
            importMatches.push({ full: m[0], clause: m[1].trim(), spec: m[2].trim() });
        }

        for (const imp of importMatches) {
            const depUrl = new URL(imp.spec, moduleUrl || (SERVER_URL + '/assets/mv/engine.mjs')).href;
            const depMod = await loadEsmModuleByUrl(depUrl);
            const clause = imp.clause;

            if (clause.startsWith('*')) {
                const nsName = clause.split(/\s+as\s+/)[1].trim();
                scopeObj[nsName] = depMod;
            } else {
                const braceIdx = clause.indexOf('{');
                if (braceIdx !== -1) {
                    const beforeBrace = clause.slice(0, braceIdx).replace(',', '').trim();
                    if (beforeBrace) {
                        scopeObj[beforeBrace] = depMod.default !== undefined ? depMod.default : depMod;
                    }
                    const insideBrace = clause.slice(braceIdx + 1, clause.lastIndexOf('}'));
                    insideBrace.split(',').forEach(function(part) {
                        const p = part.trim();
                        if (!p) return;
                        const segs = p.split(/\s+as\s+/);
                        const origName = segs[0].trim();
                        const localName = (segs[1] || segs[0]).trim();
                        scopeObj[localName] = depMod[origName];
                    });
                } else {
                    scopeObj[clause] = depMod.default !== undefined ? depMod.default : depMod;
                }
            }
            transformed = transformed.replace(imp.full, '');
        }

        transformed = transformed.replace(/^\s*import\s+['"][^'"]+['"]\s*;?/gm, '');
        scopeObj.__am_dynamic_import = function(spec) {
            const depUrl = new URL(spec, moduleUrl || (SERVER_URL + '/assets/mv/engine.mjs')).href;
            return loadEsmModuleByUrl(depUrl);
        };
        transformed = transformed.replace(/\bimport\s*\(/g, '__am_dynamic_import(');
        transformed = transformed.replace(/export\s+default\s+async\s+function\s*([a-zA-Z0-9_$]*)/g, function(_, name) {
            return name ? ('async function ' + name) : '__exports.default = async function';
        });
        transformed = transformed.replace(/export\s+default\s+function\s*([a-zA-Z0-9_$]*)/g, function(_, name) {
            return name ? ('function ' + name) : '__exports.default = function';
        });
        transformed = transformed.replace(/export\s+default\s+class\s*([a-zA-Z0-9_$]*)/g, function(_, name) {
            return name ? ('class ' + name) : '__exports.default = class';
        });
        transformed = transformed.replace(/export\s+default\s+/g, '__exports.default = ');
        const defNamedMatch = codeStr.match(/export\s+default\s+(?:async\s+)?(?:function|class)\s+([a-zA-Z0-9_$]+)/);
        const defAssign = defNamedMatch ? ('\n__exports.default = ' + defNamedMatch[1] + ';') : '';
        transformed = transformed.replace(/export\s+async\s+function\s+([a-zA-Z0-9_$]+)/g, 'async function $1');
        transformed = transformed.replace(/export\s+function\s+([a-zA-Z0-9_$]+)/g, 'function $1');
        transformed = transformed.replace(/export\s+class\s+([a-zA-Z0-9_$]+)/g, 'class $1');
        transformed = transformed.replace(/export\s+(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=/g, 'const $1 = __exports.$1 =');

        const fnMatches = codeStr.match(/export\s+(?:async\s+)?(?:function|class)\s+([a-zA-Z0-9_$]+)/g) || [];
        const exportAssigns = fnMatches.map(function(item) {
            const name = item.split(/\s+/).pop();
            return '__exports.' + name + ' = typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined;';
        }).join('\n');

        transformed = transformed.replace(/export\s*\{([^}]+)\}\s*;?/g, function(_, list) {
            return list.split(',').map(function(item) {
                const parts = item.trim().split(/\s+as\s+/);
                const localName = parts[0].trim();
                const expName = (parts[1] || parts[0]).trim();
                return localName ? ('__exports.' + expName + ' = ' + localName + ';') : '';
            }).join('\n');
        });

        const scopeKeys = Object.keys(scopeObj);
        const scopeVals = scopeKeys.map(function(k) { return scopeObj[k]; });

        if (workerContext) {
            const workerTransformed = transformed.replace(/\bimportScripts\s*\(/g, 'await self.__asyncImportScripts(');
            const workerFooter = [
                '',
                'self.__dispatchToWorker = function(e) {',
                '  const fn = self.onmessage || (typeof onmessage === "function" ? onmessage : null);',
                '  if (typeof fn === "function") fn.call(self, e);',
                '  const list = self._msgListeners.slice();',
                '  for (const l of list) {',
                '    if (typeof l === "function") l.call(self, e);',
                '    else if (l && typeof l.handleEvent === "function") l.handleEvent(e);',
                '  }',
                '};'
            ].join('\n');
            const runner = new Function(
                'window', 'self', 'globalThis', 'importScripts', 'postMessage', 'addEventListener', 'removeEventListener', 'fetch', 'location', 'close', '__exports',
                ...scopeKeys,
                'return (async function() {\nwith (self) {\nlet onmessage = null;\n' + workerTransformed + '\n' + exportAssigns + defAssign + workerFooter + '\n}\n})();'
            );
            await runner.call(
                workerContext,
                workerContext, workerContext, workerContext, workerContext.importScripts,
                workerContext.postMessage, workerContext.addEventListener, workerContext.removeEventListener,
                workerContext.fetch, workerContext.location, workerContext.close,
                exportsObj,
                ...scopeVals
            );
        } else {
            const runner = new Function('window', 'self', 'globalThis', '__exports', ...scopeKeys, transformed + '\n' + exportAssigns + defAssign);
            runner.call(pageWindow, pageWindow, pageWindow, pageWindow, exportsObj, ...scopeVals);
        }
        return exportsObj;
    }

    let mvModulesCache = null;
    async function loadMvModules() {
        if (mvModulesCache) return mvModulesCache;
        installNetworkAndWorkerHooks();
        installBlobClickHook();
        const hlsMod = await loadEsmModuleByUrl(SERVER_URL + '/assets/mv/hls.mjs');
        const engMod = await loadEsmModuleByUrl(SERVER_URL + '/assets/mv/engine.mjs');
        mvModulesCache = {
            parseMaster: hlsMod.parseMaster,
            recommendedAudio: hlsMod.recommendedAudio,
            fetchMaster: engMod.fetchMaster,
            downloadMV: engMod.downloadMV
        };
        return mvModulesCache;
    }

    function createEl(tag, className, text) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined && text !== null) el.textContent = text;
        return el;
    }

    function createSvgIcon(viewBox, pathList, width, height, isStroke) {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', viewBox);
        if (width) svg.setAttribute('width', String(width));
        if (height) svg.setAttribute('height', String(height));
        if (isStroke) {
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '2');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('stroke-linejoin', 'round');
        }
        pathList.forEach(function(d) {
            const path = document.createElementNS(ns, 'path');
            path.setAttribute('d', d);
            svg.appendChild(path);
        });
        return svg;
    }

    let isDownloadCancelled = false;
    const downloadQueue = [];
    let isDownloading = false;
    let globalDirHandle = null;

    function ensureStatusToastDOM() {
        let toast = document.getElementById('am-helper-status-toast');
        if (toast) return toast;

        toast = createEl('div', 'am-status-toast');
        toast.id = 'am-helper-status-toast';

        const toggleBtn = createEl('button', 'am-taskbar-toggle-btn');
        toggleBtn.id = 'am-toggleTaskbarBtn';
        toggleBtn.title = '最小化';
        toggleBtn.appendChild(createSvgIcon('0 0 24 24', ['M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z']));

        const left = createEl('div', 'am-taskbar-left');
        const badge = createEl('div', 'am-queue-badge', '0');
        badge.id = 'am-queueBadge';
        badge.title = '点击查看等待队列';
        const popup = createEl('div', 'am-queue-popup');
        popup.id = 'am-queuePopup';
        left.appendChild(badge);
        left.appendChild(popup);

        const center = createEl('div', 'am-taskbar-center');
        const row1 = createEl('div', 'am-taskbar-row1', '');
        row1.id = 'am-taskbar-row1';
        const row2 = createEl('div', 'am-taskbar-row2');
        const trackSpan = createEl('span', '', '准备中...');
        trackSpan.id = 'am-taskbar-track';
        const speedSpan = createEl('span', '', '0.00 MB/s');
        speedSpan.id = 'am-taskbar-speed';
        const pctSpan = createEl('span', '', '0%');
        pctSpan.id = 'am-taskbar-pct';
        const sizeSpan = createEl('span', '', '');
        sizeSpan.id = 'am-taskbar-size';
        row2.appendChild(trackSpan);
        row2.appendChild(speedSpan);
        row2.appendChild(pctSpan);
        row2.appendChild(sizeSpan);
        center.appendChild(row1);
        center.appendChild(row2);

        const right = createEl('div', 'am-taskbar-right');
        const cancelBtn = createEl('button', 'am-taskbar-cancel-btn', '取消下载');
        cancelBtn.id = 'am-cancelDownloadBtn';
        right.appendChild(cancelBtn);

        const fill = createEl('div', 'am-taskbar-total-progress-fill');
        fill.id = 'am-taskbarTotalProgressFill';

        toast.appendChild(toggleBtn);
        toast.appendChild(left);
        toast.appendChild(center);
        toast.appendChild(right);
        toast.appendChild(fill);
        document.body.appendChild(toast);

        toggleBtn.addEventListener('click', function() {
            const isMin = toast.classList.toggle('minimized');
            toggleBtn.textContent = '';
            toggleBtn.appendChild(createSvgIcon('0 0 24 24', [
                isMin ? 'M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6 1.41 1.41z' : 'M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z'
            ]));
            toggleBtn.title = isMin ? '恢复显示' : '最小化';
            if (isMin) popup.classList.remove('open');
        });

        cancelBtn.addEventListener('click', function() {
            isDownloadCancelled = true;
        });

        badge.addEventListener('click', function() {
            popup.classList.toggle('open');
        });

        popup.addEventListener('click', function(e) {
            const btn = e.target.closest('.am-queue-cancel-btn');
            if (btn) {
                const qId = btn.getAttribute('data-queue-id');
                const idx = downloadQueue.findIndex(function(q) { return q.id === String(qId); });
                if (idx !== -1) {
                    const removed = downloadQueue.splice(idx, 1)[0];
                    if (removed && removed.buttonElement) removed.buttonElement.disabled = false;
                    updateQueueUI();
                }
            }
        });

        return toast;
    }

    function showStatusToast(item) {
        const toast = ensureStatusToastDOM();
        toast.classList.remove('minimized');
        const cancelBtn = document.getElementById('am-cancelDownloadBtn');
        if (cancelBtn) cancelBtn.style.display = 'block';
        const sizeElem = document.getElementById('am-taskbar-size');
        if (sizeElem) sizeElem.textContent = '';
        const totalFillElem = document.getElementById('am-taskbarTotalProgressFill');
        if (totalFillElem) totalFillElem.style.width = '0%';
        const row1 = document.getElementById('am-taskbar-row1');
        if (row1) {
            row1.textContent = (item.name || '未知专辑') + ' （' + (item.completedTracks || 0) + '/' + (item.totalTracks || 1) + '）';
        }
        toast.classList.add('show');
    }

    function hideStatusToast() {
        const toast = document.getElementById('am-helper-status-toast');
        if (!toast) return;
        toast.classList.remove('show', 'minimized');
        const popup = document.getElementById('am-queuePopup');
        if (popup) popup.classList.remove('open');
    }

    function updateToastProgress(data) {
        const toast = document.getElementById('am-helper-status-toast');
        if (!toast || !toast.classList.contains('show')) return;

        const row1 = document.getElementById('am-taskbar-row1');
        const trackElem = document.getElementById('am-taskbar-track');
        const pctElem = document.getElementById('am-taskbar-pct');
        const speedElem = document.getElementById('am-taskbar-speed');
        const sizeElem = document.getElementById('am-taskbar-size');
        const totalFillElem = document.getElementById('am-taskbarTotalProgressFill');

        if (data.albumName !== undefined && row1) {
            const doneCount = data.completedTracks !== undefined ? data.completedTracks : 0;
            const totalCount = data.totalTracks !== undefined ? data.totalTracks : 1;
            row1.textContent = data.albumName + ' （' + doneCount + '/' + totalCount + '）';
            if (totalFillElem && totalCount !== 0) {
                totalFillElem.style.width = Math.round((doneCount / totalCount) * 100) + '%';
            }
        }
        if (data.trackName !== undefined && trackElem) {
            trackElem.style.color = '';
            trackElem.textContent = data.trackName;
        }
        if (data.percent !== undefined) {
            const pctStr = typeof data.percent === 'number' ? (data.percent + '%') : data.percent;
            if (pctElem) pctElem.textContent = pctStr;
            if (typeof data.percent === 'number' && totalFillElem && row1 && row1.textContent.includes('/1）')) {
                totalFillElem.style.width = data.percent + '%';
            }
        }
        if (data.speed !== undefined && speedElem) {
            speedElem.textContent = data.speed;
        }
        if (data.size !== undefined && sizeElem) {
            sizeElem.textContent = data.size;
        }
        if (data.status === 'error' && trackElem) {
            trackElem.style.color = '#ff5555';
            trackElem.textContent = '错误: ' + (data.error || '未知');
        }

        const cancelBtn = document.getElementById('am-cancelDownloadBtn');
        if (cancelBtn) {
            if (data.status === 'finished' || data.status === 'error') {
                cancelBtn.style.display = 'none';
            } else if (data.status === 'running') {
                cancelBtn.style.display = 'block';
            }
        }
    }

    function updateQueueUI() {
        const badge = document.getElementById('am-queueBadge');
        const popup = document.getElementById('am-queuePopup');
        if (!badge || !popup) return;
        badge.textContent = String(downloadQueue.length);
        popup.textContent = '';
        if (downloadQueue.length === 0) {
            const empty = createEl('div', '', '暂无排队任务');
            empty.style.cssText = 'color:#B3B3B3; text-align:center; padding:8px; font-size:12px;';
            popup.appendChild(empty);
        } else {
            downloadQueue.forEach(function(qItem, idx) {
                const row = createEl('div', 'am-queue-item');
                const title = createEl('span', 'am-queue-item-title', (idx + 1) + '. ' + qItem.title);
                const btn = createEl('button', 'am-queue-cancel-btn', '取消下载');
                btn.setAttribute('data-queue-id', qItem.id);
                row.appendChild(title);
                row.appendChild(btn);
                popup.appendChild(row);
            });
        }
    }

    function getStorefront() {
        const parts = window.location.pathname.split('/').filter(Boolean);
        return parts[0] || 'cn';
    }

    async function getDirectoryHandle() {
        if (!globalDirHandle) {
            const picker = window.showDirectoryPicker || pageWindow.showDirectoryPicker;
            if (!picker) {
                throw new Error('当前浏览器不支持文件夹读写 API，请使用 Chrome 或 Edge 浏览器');
            }
            try {
                globalDirHandle = await picker.call(pageWindow, { mode: 'readwrite' });
            } catch (e) {
                throw new Error('已取消本地保存文件夹授权');
            }
        }
        return globalDirHandle;
    }

    async function getAlbumDetails(item, lightweight, minRate, forceM3u8) {
        const sf = getStorefront();
        const lwParam = lightweight ? '1' : '0';
        const rateParam = (minRate && minRate !== 0) ? ('&min_rate=' + minRate) : '';
        const m3u8Param = forceM3u8 ? '&check_m3u8=1' : '';
        const reqUrl = '/api/parse?q=' + encodeURIComponent(item.rawUrl || item.id) + '&lightweight=' + lwParam + '&sf=' + encodeURIComponent(sf) + rateParam + m3u8Param;
        const data = await gmFetchJson(reqUrl);
        if (data.error || data.msg) throw new Error(data.error || data.msg);

        const realTitle = data.title || data.name || item.name || '';
        const realArtist = data.artist || item.artist || '';
        return Object.assign({}, item, {
            id: data.id || item.id,
            type: data.type || item.type,
            name: realTitle,
            title: realTitle,
            artist: realArtist,
            coverUrl: data.coverUrl || item.coverUrl || '',
            previewVideoUrl: data.previewVideoUrl || item.previewVideoUrl || '',
            audioTraits: data.audioTraits || item.audioTraits || [],
            trackCount: data.trackCount || (data.tracks ? data.tracks.length : 0),
            releaseDate: data.releaseDate || item.releaseDate || '',
            contentRating: data.contentRating || item.contentRating || '',
            tracks: data.tracks || [],
            fullTitle: realTitle,
            fullArtist: realArtist
        });
    }

    function selectStreamUrl(heavyTrack, quality) {
        const variants = heavyTrack.variants || [];
        if (variants.length !== 0) {
            if (quality === 'atmos') {
                const atmosVar = variants.find(function(v) {
                    return v.codecs && (v.codecs.toLowerCase() === 'ec-3' || v.codecs.toLowerCase() === 'ec3');
                });
                if (!atmosVar || !atmosVar.m3u8Url) {
                    throw new Error('该曲目没有 Atmos 全景声音轨');
                }
                return atmosVar.m3u8Url;
            }
            const alacVariants = variants.filter(function(v) {
                return v.codecs && v.codecs.toLowerCase() === 'alac';
            });
            if (alacVariants.length !== 0) {
                if (quality === 'hires') {
                    const hiresVar = alacVariants.find(function(v) {
                        return (v.sampleRate && !isNaN(v.sampleRate) && Math.max(v.sampleRate, 88200) === v.sampleRate) || (v.label && /(88\.2|96|176\.4|192)kHz/i.test(v.label));
                    });
                    const pickedHires = hiresVar || alacVariants[0];
                    if (pickedHires && pickedHires.m3u8Url) return pickedHires.m3u8Url;
                } else if (quality === 'lossless') {
                    const stdVars = alacVariants.filter(function(v) {
                        return (v.sampleRate && Math.min(v.sampleRate, 48000) === v.sampleRate) || (v.label && /(44\.1|48)kHz/i.test(v.label));
                    });
                    const pickedLossless = stdVars.length !== 0 ? stdVars[0] : alacVariants[alacVariants.length - 1];
                    if (pickedLossless && pickedLossless.m3u8Url) return pickedLossless.m3u8Url;
                }
            }
        }
        return heavyTrack.m3u8Url || (heavyTrack.previewUrl ? ('/proxy_seg?url=' + encodeURIComponent(heavyTrack.previewUrl)) : '');
    }

    function installBlobClickHook() {
        if (pageWindow.__am_click_hook_installed) return;
        pageWindow.__am_blob_tasks = {};
        pageWindow.__am_blob_store = new Map();

        function patchUrlAndAnchor(winObj) {
            if (!winObj) return;

            if (winObj.URL && winObj.URL.createObjectURL && !winObj.URL.__am_patched) {
                const origCreateObjURL = winObj.URL.createObjectURL.bind(winObj.URL);
                winObj.URL.createObjectURL = function(obj) {
                    const bUrl = origCreateObjURL(obj);
                    if (obj && typeof obj.arrayBuffer === 'function') {
                        pageWindow.__am_blob_store.set(bUrl, obj);
                    }
                    return bUrl;
                };
                winObj.URL.__am_patched = true;
            }

            if (!winObj.HTMLAnchorElement) return;
            const origAnchorClick = winObj.HTMLAnchorElement.prototype.click;
            const origHtmlClick = winObj.HTMLElement ? winObj.HTMLElement.prototype.click : null;

            const router = function() {
                if (this.tagName === 'A' && this.href && this.href.startsWith('blob:')) {
                    const dlName = this.download || '';
                    const keys = Object.keys(pageWindow.__am_blob_tasks);
                    const taskKey = keys.find(function(k) {
                        return (dlName && (dlName.includes(k) || k.includes(dlName)));
                    }) || keys[0];
                    if (taskKey) {
                        pageWindow.__am_blob_tasks[taskKey](this.href);
                        return;
                    }
                }
                if (origAnchorClick && this instanceof winObj.HTMLAnchorElement) return origAnchorClick.apply(this, arguments);
                if (origHtmlClick) return origHtmlClick.apply(this, arguments);
            };

            winObj.HTMLAnchorElement.prototype.click = router;
            if (winObj.HTMLElement) winObj.HTMLElement.prototype.click = router;
        }

        patchUrlAndAnchor(pageWindow);
        if (window !== pageWindow) patchUrlAndAnchor(window);
        pageWindow.__am_click_hook_installed = true;
    }

    async function downloadSingleTrackInternal(item, trackData, trackTitle, dlUrl) {
        await ensureAmDecryptLoaded();
        installBlobClickHook();

        const rawTitle = trackTitle || item.fullTitle || item.title || item.name || 'Apple_Music_Track';
        const safeName = String(rawTitle).replace(/[\\/:*?"<>|\r\n]+/g, '_').trim() || 'Apple_Music_Track';
        const isVideo = dlUrl.includes('/api/mv_info') || dlUrl.includes('/proxy_seg') || item.type === 'video' || item.type === 'music-video';
        const ext = isVideo ? '.mp4' : '.m4a';
        const finalFileName = safeName.endsWith(ext) ? safeName : (safeName + ext);
        const tmpFileName = finalFileName + '.tmp';

        let lastTime = Date.now();
        let lastBytes = 0;
        let currentSpeedStr = '0.00 MB/s';

        const calcSpeed = function(doneBytes) {
            const now = Date.now();
            const dt = (now - lastTime) / 1000;
            if (Math.max(dt, 0.3) === dt) {
                const diff = Math.max(0, doneBytes - lastBytes);
                const bps = diff / dt;
                currentSpeedStr = Math.max(bps, 1048576) === bps
                    ? (bps / 1048576).toFixed(2) + ' MB/s'
                    : (bps / 1024).toFixed(1) + ' KB/s';
                lastTime = now;
                lastBytes = doneBytes;
            }
            return currentSpeedStr;
        };

        const onProgressUpdate = function(text, isFinished, pct, speed) {
            updateToastProgress({
                status: isFinished ? 'finished' : 'running',
                trackName: rawTitle,
                percent: pct !== undefined ? pct : text,
                speed: speed !== undefined ? speed : currentSpeedStr
            });
        };

        const rootDirHandle = await getDirectoryHandle();
        const artistName = String(item.artist || item.fullArtist || trackData.artist || '未知歌手').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim();
        const albumName = String(item.name || item.fullTitle || item.album || trackData.album || '未知专辑').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim();

        const artistDirHandle = await rootDirHandle.getDirectoryHandle(artistName, { create: true });
        const calcTotalDiscs = item.tracks && item.tracks.length !== 0
            ? Math.max(1, ...item.tracks.map(function(t) { return t.disk_number || t.disc_number || t.discNumber || 1; }))
            : 1;
        const calcDiscNumber = trackData.diskNumber || trackData.disk_number || trackData.discNumber || 1;

        let targetDirHandle;
        if (isVideo) {
            targetDirHandle = await artistDirHandle.getDirectoryHandle('video', { create: true });
        } else {
            const albumDirHandle = await artistDirHandle.getDirectoryHandle(albumName, { create: true });
            if (calcTotalDiscs !== 1) {
                targetDirHandle = await albumDirHandle.getDirectoryHandle('CD' + calcDiscNumber, { create: true });
            } else {
                targetDirHandle = albumDirHandle;
            }
        }

        try {
            await targetDirHandle.getFileHandle(finalFileName);
            onProgressUpdate('已跳过 (本地已存在)', true);
            return;
        } catch (e) {}

        const tmpFileHandle = await targetDirHandle.getFileHandle(tmpFileName, { create: true });
        const cleanDlPath = String(dlUrl).split('?')[0].toLowerCase();

        if (dlUrl.startsWith('/proxy_seg') || cleanDlPath.endsWith('.mp4') || cleanDlPath.endsWith('.m4v')) {
            onProgressUpdate('正在下载视频流...', false, 10);
            const vResp = await gmFetchRaw(dlUrl, { responseType: 'arraybuffer', timeout: 300000 });
            if (vResp.status !== 200 || !vResp.response) {
                await targetDirHandle.removeEntry(tmpFileName);
                throw new Error('视频直链下载失败 (HTTP ' + vResp.status + ')');
            }
            onProgressUpdate('写入硬盘: 100%', false, 100);
            const vWritable = await tmpFileHandle.createWritable();
            await vWritable.write(vResp.response);
            await vWritable.close();
            try {
                if (tmpFileHandle.move) await tmpFileHandle.move(finalFileName);
                else throw new Error('move unsupported');
            } catch (e) {
                const finalFileHandle = await targetDirHandle.getFileHandle(finalFileName, { create: true });
                const fWritable = await finalFileHandle.createWritable();
                const file = await tmpFileHandle.getFile();
                await fWritable.write(file);
                await fWritable.close();
                await targetDirHandle.removeEntry(tmpFileName);
            }
            return;
        }

        const isAtmosTrack = (trackData.variants || []).some(function(v) {
            return v.m3u8Url === dlUrl && v.codecs && v.codecs.toLowerCase().includes('ec');
        });
        let metaObj = {};

        let blobWritePromise = new Promise(function(resolve) {
            pageWindow.__am_blob_tasks[tmpFileName] = async function(blobUrl) {
                try {
                    onProgressUpdate('读取临时文件...');
                    const rawBlob = pageWindow.__am_blob_store && pageWindow.__am_blob_store.get(blobUrl);
                    if (!rawBlob) {
                        throw new Error('未在内存映射中找到音频 Blob 数据');
                    }
                    let fileBuffer = await rawBlob.arrayBuffer();
                    const rawBackupBuffer = fileBuffer.slice(0);
                    pageWindow.__am_blob_store.delete(blobUrl);
                    try { URL.revokeObjectURL(blobUrl); } catch (e) {}

                    try {
                        onProgressUpdate('FFmpeg写入元数据中...');
                        const ff = await getFFmpegInstance();
                        const randHash = Math.random().toString(36).slice(2, 8);
                        const inputName = 'in_' + Date.now() + '_' + randHash + ext;
                        const outputName = 'out_' + Date.now() + '_' + randHash + ext;

                        ff.FS('writeFile', inputName, new Uint8Array(fileBuffer));
                        const ffmpegArgs = ['-y', '-i', inputName];

                        if (!isVideo && metaObj.coverUrl) {
                            try {
                                const coverResp = await gmFetchRaw(metaObj.coverUrl.replace(/\d+x\d+/, '2000x2000'), { responseType: 'arraybuffer' });
                                if (coverResp.status === 200 && coverResp.response) {
                                    ff.FS('writeFile', 'cover.jpg', new Uint8Array(coverResp.response));
                                    ffmpegArgs.push('-i', 'cover.jpg', '-map', '0:a:0', '-map', '1:0', '-c:a', 'copy', '-c:v', 'copy', '-disposition:v:0', 'attached_pic');
                                } else {
                                    ffmpegArgs.push('-map', '0:a:0', '-c:a', 'copy');
                                }
                            } catch (coverErr) {
                                ffmpegArgs.push('-map', '0:a:0', '-c:a', 'copy');
                            }
                        } else if (!isVideo) {
                            ffmpegArgs.push('-map', '0:a:0', '-c:a', 'copy');
                        } else {
                            ffmpegArgs.push('-c', 'copy');
                        }

                        ffmpegArgs.push('-map_metadata', '-1');
                        ffmpegArgs.push('-movflags', '+faststart');

                        if (metaObj.title) ffmpegArgs.push('-metadata', 'title=' + metaObj.title);
                        if (metaObj.artist) ffmpegArgs.push('-metadata', 'artist=' + metaObj.artist);
                        if (metaObj.albumArtist) ffmpegArgs.push('-metadata', 'album_artist=' + metaObj.albumArtist);
                        if (metaObj.album) ffmpegArgs.push('-metadata', 'album=' + metaObj.album);
                        ffmpegArgs.push('-metadata', 'track=' + metaObj.trackNumber + '/' + metaObj.totalTracks);
                        ffmpegArgs.push('-metadata', 'disc=' + metaObj.discNumber + '/' + metaObj.totalDiscs);
                        if (metaObj.releaseDate || metaObj.year) ffmpegArgs.push('-metadata', 'date=' + (metaObj.releaseDate || metaObj.year));

                        if (!isAtmosTrack) {
                            if (metaObj.lyrics) ffmpegArgs.push('-metadata', 'lyrics=' + metaObj.lyrics);
                            if (metaObj.genre) ffmpegArgs.push('-metadata', 'genre=' + metaObj.genre);
                            if (metaObj.copyright) ffmpegArgs.push('-metadata', 'copyright=' + metaObj.copyright);
                            if (metaObj.description) {
                                ffmpegArgs.push('-metadata', 'description=' + metaObj.description);
                                ffmpegArgs.push('-metadata', 'comment=' + metaObj.description);
                                ffmpegArgs.push('-metadata', 'synopsis=' + metaObj.description);
                            }
                            if (metaObj.isrc) ffmpegArgs.push('-metadata', 'isrc=' + metaObj.isrc);
                            if (metaObj.upc) ffmpegArgs.push('-metadata', 'upc=' + metaObj.upc);
                        }

                        if (isAtmosTrack) {
                            ffmpegArgs.push('-f', 'mp4');
                        }
                        ffmpegArgs.push(outputName);

                        try {
                            await ff.run.apply(ff, ffmpegArgs);
                        } catch (runErr) {
                            if (!runErr || !runErr.message || !runErr.message.includes('exit(0)')) {
                                throw runErr;
                            }
                        }

                        const stat = ff.FS('stat', outputName);
                        if (!stat || stat.size === 0) {
                            throw new Error('FFmpeg 生成了 0 字节文件');
                        }
                        const outBuffer = ff.FS('readFile', outputName).buffer;
                        if (outBuffer && outBuffer.byteLength !== 0) {
                            fileBuffer = outBuffer;
                        } else {
                            fileBuffer = rawBackupBuffer;
                        }

                        try { ff.FS('unlink', inputName); } catch (e) {}
                        try { ff.FS('unlink', outputName); } catch (e) {}
                        try { ff.FS('unlink', 'cover.jpg'); } catch (e) {}
                        try { ff.exit(); } catch (e) {}
                    } catch (ffErr) {
                        console.warn('[METADATA WARN] FFmpeg 写入元数据失败，回退保存原始流:', ffErr);
                        fileBuffer = rawBackupBuffer;
                    }

                    onProgressUpdate('写入本地硬盘...');
                    const writable = await tmpFileHandle.createWritable();
                    await writable.write(fileBuffer);
                    await writable.close();
                    onProgressUpdate('封装完成');
                } catch (e) {
                    console.error('写入文件失败:', e);
                } finally {
                    delete pageWindow.__am_blob_tasks[tmpFileName];
                    resolve();
                }
            };
        });

        try {
            const amDecrypt = pageWindow.AmDecrypt || window.AmDecrypt;
            const fullDlUrl = dlUrl.startsWith('/') ? (SERVER_URL + dlUrl) : dlUrl;
            const track = await amDecrypt.openTrack(fullDlUrl);
            const calcTotalTracks = trackData.totalTracksInDisc || item.trackCount || (item.tracks ? item.tracks.length : 1);

            metaObj = {
                title: trackData.title || trackTitle || safeName,
                artist: trackData.artist || item.artist || item.fullArtist,
                albumArtist: item.artist || item.fullArtist,
                album: trackData.album || item.album || item.name || item.fullTitle,
                lyrics: trackData.lyrics || item.lyrics || '',
                trackNumber: trackData.trackNumber || trackData.track_number || 1,
                totalTracks: calcTotalTracks,
                discNumber: calcDiscNumber,
                totalDiscs: calcTotalDiscs,
                releaseDate: trackData.releaseDate || item.releaseDate || '',
                year: (trackData.releaseDate || item.releaseDate || '').substring(0, 4),
                isrc: trackData.isrc || item.isrc || '',
                upc: trackData.upc || item.upc || '',
                genre: trackData.genre || item.genre || '',
                copyright: trackData.copyright || item.copyright || '',
                description: trackData.editorialNotes || item.editorialNotes || ''
            };

            if (!isVideo) {
                metaObj.coverUrl = trackData.coverUrl || item.coverUrl;
                metaObj.picture = trackData.coverUrl || item.coverUrl;
                metaObj.cover = trackData.coverUrl || item.coverUrl;
                metaObj.artwork = trackData.coverUrl || item.coverUrl;
            }

            if (track && typeof track === 'object') {
                Object.assign(track, metaObj);
                track.filename = tmpFileName;
                track.fileName = tmpFileName;
                track.name = safeName;
                track.metadata = metaObj;
                track.tags = metaObj;
                track.meta = metaObj;
            }

            await amDecrypt.download(track, tmpFileName, {
                filename: tmpFileName,
                fileName: tmpFileName,
                fileHandle: tmpFileHandle,
                metadata: metaObj,
                tags: metaObj,
                meta: metaObj,
                onProgress: function(done, total) {
                    if (isDownloadCancelled) throw new Error('用户取消下载');
                    const pct = total ? Math.round((done / total) * 100) : 0;
                    onProgressUpdate('解密: ' + pct + '%', false, pct, calcSpeed(done));
                }
            });

            await blobWritePromise;

            const checkFile = await tmpFileHandle.getFile();
            if (!checkFile || checkFile.size === 0) {
                await targetDirHandle.removeEntry(tmpFileName);
                throw new Error('生成的音频文件为空');
            }

            try {
                if (tmpFileHandle.move) {
                    await tmpFileHandle.move(finalFileName);
                } else {
                    throw new Error('move unsupported');
                }
            } catch (e) {
                const finalFileHandle = await targetDirHandle.getFileHandle(finalFileName, { create: true });
                const fWritable = await finalFileHandle.createWritable();
                const file = await tmpFileHandle.getFile();
                await fWritable.write(file);
                await fWritable.close();
                await targetDirHandle.removeEntry(tmpFileName);
            }
        } catch (err) {
            delete pageWindow.__am_blob_tasks[tmpFileName];
            try { await targetDirHandle.removeEntry(tmpFileName); } catch (e) {}
            throw err;
        }
    }

    async function enqueueDownloadTask(title, buttonElement, taskFn) {
        try {
            await getDirectoryHandle();
        } catch (err) {
            if (buttonElement) buttonElement.disabled = false;
            alert(err.message || '取消了文件夹授权');
            return;
        }

        const taskObj = {
            id: String(Date.now() + Math.random()),
            title: title,
            buttonElement: buttonElement,
            taskFn: taskFn
        };

        if (isDownloading) {
            downloadQueue.push(taskObj);
            updateQueueUI();
            return;
        }

        isDownloading = true;
        let current = taskObj;
        while (current) {
            updateQueueUI();
            try {
                await current.taskFn();
            } finally {
                if (current.buttonElement) current.buttonElement.disabled = false;
            }
            current = downloadQueue.shift();
            updateQueueUI();
        }
        isDownloading = false;
        setTimeout(function() {
            if (!isDownloading && downloadQueue.length === 0) {
                hideStatusToast();
            }
        }, 3000);
    }

    async function startDirectInPageDownload(url, details, quality, buttonElement) {
        if (buttonElement) buttonElement.disabled = true;
        const itemTitle = (details && details.name) ? details.name : 'Apple Music 作品';
        const isVideoUrl = String(url).includes('/music-video/');
        const itemObj = {
            rawUrl: url,
            name: itemTitle,
            artist: (details && details.artist) ? details.artist : '未知歌手',
            type: isVideoUrl ? 'video' : 'album',
            id: 'direct_' + Date.now()
        };

        await enqueueDownloadTask(itemTitle, buttonElement, async function() {
            isDownloadCancelled = false;
            showStatusToast({ name: itemTitle, completedTracks: 0, totalTracks: 1 });

            try {
                updateToastProgress({ status: 'running', trackName: '正在解析作品信息...', percent: 0, speed: '0.00 MB/s' });
                const fullItem = await getAlbumDetails(itemObj, true, 0, false);
                const albumTitle = fullItem.name || itemTitle;

                if (isVideoUrl || fullItem.type === 'video' || fullItem.type === 'music-video') {
                    const rootDirHandle = await getDirectoryHandle();
                    const artistName = String(fullItem.artist || fullItem.fullArtist || '未知歌手').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim();
                    const artistDirHandle = await rootDirHandle.getDirectoryHandle(artistName, { create: true });
                    const targetDirHandle = await artistDirHandle.getDirectoryHandle('video', { create: true });
                    const safeName = String(fullItem.name || fullItem.title || 'MV').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim();
                    const finalFileName = safeName + '.mp4';

                    try {
                        await targetDirHandle.getFileHandle(finalFileName);
                        updateToastProgress({ status: 'finished', albumName: albumTitle, completedTracks: 1, totalTracks: 1, trackName: finalFileName, percent: '已跳过 (本地已存在)', speed: '' });
                        return;
                    } catch (e) {}

                    let mvId = fullItem.id;
                    if (!mvId || String(mvId).startsWith('direct_')) {
                        const urlParts = String(fullItem.rawUrl || url).split('?')[0].split('/').filter(Boolean);
                        const lastPart = urlParts.pop();
                        if (lastPart && !isNaN(Number(lastPart))) mvId = lastPart;
                    }

                    const tmpFileHandle = await targetDirHandle.getFileHandle(finalFileName + '.tmp', { create: true });
                    let resultObj = null;
                    try {
                        updateToastProgress({ status: 'running', albumName: albumTitle, completedTracks: 0, totalTracks: 1, trackName: '正在解析视频流...', percent: 0 });
                        const mvEngine = await loadMvModules();
                        const masterRes = await mvEngine.fetchMaster(mvId, new AbortController().signal);
                        const master = mvEngine.parseMaster(masterRes.masterBody, masterRes.masterUrl);
                        const selectedVideo = master.videos[0];
                        const selectedAudio = mvEngine.recommendedAudio(selectedVideo, master.audios);

                        let mvLastTime = Date.now();
                        let mvLastBytes = 0;
                        let mvSpeedStr = '0.00 MB/s';

                        resultObj = await mvEngine.downloadMV(mvId, selectedVideo, selectedAudio, {
                            signal: new AbortController().signal,
                            fileHandle: tmpFileHandle,
                            onProgress: function(val, bytes) {
                                if (isDownloadCancelled) throw new Error('用户取消下载');
                                const now = Date.now();
                                const dt = (now - mvLastTime) / 1000;
                                if (Math.max(dt, 0.3) === dt) {
                                    const diff = Math.max(0, bytes - mvLastBytes);
                                    const bps = diff / dt;
                                    mvSpeedStr = Math.max(bps, 1048576) === bps ? ((bps / 1048576).toFixed(2) + ' MB/s') : ((bps / 1024).toFixed(1) + ' KB/s');
                                    mvLastTime = now;
                                    mvLastBytes = bytes;
                                }
                                updateToastProgress({
                                    status: 'running',
                                    trackName: finalFileName,
                                    speed: mvSpeedStr,
                                    percent: Math.round(val * 100),
                                    size: (bytes / 1048576).toFixed(1) + ' MB'
                                });
                            },
                            onDefrag: function() {
                                updateToastProgress({ status: 'running', trackName: finalFileName, speed: mvSpeedStr, percent: '正在封装视频...' });
                            }
                        });

                        if (tmpFileHandle.__am_flush_promise) {
                            await tmpFileHandle.__am_flush_promise;
                        } else if (tmpFileHandle.__am_mem_buf && tmpFileHandle.__am_mem_buf.byteLength !== 0) {
                            const directW = await tmpFileHandle.createWritable();
                            await directW.write(tmpFileHandle.__am_mem_buf);
                            await directW.close();
                            delete tmpFileHandle.__am_mem_buf;
                        }

                        try {
                            if (tmpFileHandle.move) await tmpFileHandle.move(finalFileName);
                            else throw new Error('move unsupported');
                        } catch (e) {
                            const finalFileHandle = await targetDirHandle.getFileHandle(finalFileName, { create: true });
                            const fWritable = await finalFileHandle.createWritable();
                            const finalFile = await tmpFileHandle.getFile();
                            await fWritable.write(finalFile);
                            await fWritable.close();
                            await targetDirHandle.removeEntry(finalFileName + '.tmp');
                        }
                        updateToastProgress({ status: 'finished', albumName: albumTitle, completedTracks: 1, totalTracks: 1, trackName: finalFileName, speed: '已完成', percent: 100 });
                        return;
                    } catch (mvErr) {
                        console.error('[MV 引擎报错详情]:', mvErr);
                        try { await targetDirHandle.removeEntry(finalFileName + '.tmp'); } catch (e) {}
                        if (fullItem.previewVideoUrl) {
                            const directUrl = '/proxy_seg?url=' + encodeURIComponent(fullItem.previewVideoUrl);
                            await downloadSingleTrackInternal(fullItem, {}, safeName, directUrl);
                            updateToastProgress({ status: 'finished', albumName: albumTitle, completedTracks: 1, totalTracks: 1, trackName: finalFileName, speed: '已完成', percent: 100 });
                            return;
                        }
                        throw mvErr;
                    } finally {
                        if (resultObj && typeof resultObj.dispose === 'function') resultObj.dispose();
                    }
                }

                const tracks = fullItem.tracks || [];

                if (tracks.length === 0) {
                    throw new Error('未找到可下载的曲目列表');
                }

                updateToastProgress({ status: 'running', albumName: albumTitle, completedTracks: 0, totalTracks: tracks.length });

                const isSingleRelease = tracks.length === 1 || fullItem.type === 'song';
                if (fullItem.coverUrl && !isSingleRelease) {
                    try {
                        updateToastProgress({ status: 'running', trackName: '正在保存专辑封面...' });
                        const rootDirHandle = await getDirectoryHandle();
                        const artistName = String(fullItem.artist || '未知歌手').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim();
                        const albumName = String(fullItem.name || '未知专辑').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim();
                        const artistDirHandle = await rootDirHandle.getDirectoryHandle(artistName, { create: true });
                        const albumDirHandle = await artistDirHandle.getDirectoryHandle(albumName, { create: true });

                        const coverResp = await gmFetchRaw(fullItem.coverUrl.replace(/\d+x\d+/, '2000x2000'), { responseType: 'arraybuffer' });
                        if (coverResp.status === 200 && coverResp.response) {
                            const coverHandle = await albumDirHandle.getFileHandle('cover.jpg', { create: true });
                            const coverWritable = await coverHandle.createWritable();
                            await coverWritable.write(coverResp.response);
                            await coverWritable.close();
                        }
                    } catch (e) {
                        console.warn('保存封面失败:', e);
                    }
                }

                let successCount = 0;
                let maxAlbumSampleRate = quality === 'hires' ? 88200 : 0;

                const discCounts = {};
                const trackDiscIndex = tracks.map(function(t) {
                    const d = t.disk_number || t.disc_number || t.discNumber || 1;
                    discCounts[d] = (discCounts[d] || 0) + 1;
                    return discCounts[d];
                });
                const totalDiscs = Math.max(1, ...tracks.map(function(t) { return t.disk_number || t.disc_number || t.discNumber || 1; }));

                let nextTrackIndex = 0;
                const concurrencyLimit = 3;

                async function trackWorker() {
                    while (nextTrackIndex < tracks.length) {
                        if (isDownloadCancelled) break;
                        const i = nextTrackIndex++;
                        const trackLight = tracks[i];

                        const discNum = trackLight.disk_number || trackLight.disc_number || trackLight.discNumber || 1;
                        const reorderedTrackNum = trackDiscIndex[i];
                        const trackNum = String(reorderedTrackNum).padStart(2, '0');
                        const cleanName = trackLight.title || trackLight.name || fullItem.fullTitle || ('Track_' + trackNum);
                        const trackTitle = (tracks.length !== 1 || totalDiscs !== 1) ? (trackNum + '. ' + cleanName) : cleanName;

                        updateToastProgress({
                            status: 'running',
                            albumName: albumTitle,
                            completedTracks: successCount,
                            totalTracks: tracks.length,
                            trackName: trackTitle,
                            percent: 0
                        });

                        try {
                            const queryTarget = trackLight.rawUrl || trackLight.id;
                            const targetMinRate = quality === 'hires' ? maxAlbumSampleRate : -1;
                            const trackHeavy = await getAlbumDetails({ id: trackLight.id, rawUrl: queryTarget }, false, targetMinRate, false);
                            const heavyTrack = trackHeavy.tracks[0];
                            heavyTrack.disk_number = discNum;
                            heavyTrack.trackNumber = reorderedTrackNum;
                            heavyTrack.track_number = reorderedTrackNum;
                            heavyTrack.totalTracksInDisc = discCounts[discNum];
                            if (!heavyTrack.coverUrl && fullItem.coverUrl) {
                                heavyTrack.coverUrl = fullItem.coverUrl;
                            }
                            if (quality === 'hires' && heavyTrack.variants) {
                                heavyTrack.variants.forEach(function(v) {
                                    if (v.sampleRate && Math.max(v.sampleRate, maxAlbumSampleRate) === v.sampleRate) {
                                        maxAlbumSampleRate = v.sampleRate;
                                    }
                                });
                            }
                            const dlUrl = selectStreamUrl(heavyTrack, quality);
                            if (!dlUrl) {
                                console.warn('跳过无流地址曲目:', trackTitle);
                                continue;
                            }

                            await downloadSingleTrackInternal(fullItem, heavyTrack, trackTitle, dlUrl);
                            if (!isDownloadCancelled) {
                                successCount++;
                                updateToastProgress({
                                    status: 'running',
                                    albumName: albumTitle,
                                    completedTracks: successCount,
                                    totalTracks: tracks.length
                                });
                            }
                        } catch (err) {
                            console.warn('跳过或单曲下载异常:', trackTitle, err.message || err);
                            if (isDownloadCancelled) throw err;
                        }
                    }
                }

                const workers = [];
                const workerCount = Math.min(concurrencyLimit, tracks.length);
                for (let w = 0; w < workerCount; w++) {
                    workers.push(trackWorker());
                }
                await Promise.all(workers);

                if (isDownloadCancelled) {
                    throw new Error('下载已取消');
                }

                updateToastProgress({
                    status: 'finished',
                    albumName: albumTitle,
                    completedTracks: successCount,
                    totalTracks: tracks.length,
                    trackName: '下载完成（成功 ' + successCount + '/' + tracks.length + ' 首）',
                    percent: 100,
                    speed: '已完成'
                });
            } catch (error) {
                console.error('下载出错:', error);
                updateToastProgress({ status: 'error', error: error.message || String(error) });
            }
        });
    }

    let albumInfoCallback = null;
    let albumQualityCallback = null;

    async function fetchAppleCatalogApi(apiPath) {
        try {
            const mk = pageWindow.MusicKit ? pageWindow.MusicKit.getInstance() : null;
            if (mk && mk.developerToken) {
                const headers = { 'Authorization': 'Bearer ' + mk.developerToken };
                if (mk.musicUserToken) headers['Media-User-Token'] = mk.musicUserToken;
                const resp = await window.fetch('https://amp-api.music.apple.com' + apiPath, { headers: headers });
                if (resp.ok) return await resp.json();
            }
        } catch (e) {}
        return null;
    }

    const appBridge = {
        download: function(url, details, downloadType, btnEl) {
            let quality = 'hires';
            if (downloadType === 'lossless' || downloadType === 'atmos' || downloadType === 'hires') {
                quality = downloadType;
            }
            startDirectInPageDownload(url, details, quality, btnEl);
        },
        onAlbumInfoResult: function(cb) {
            albumInfoCallback = cb;
        },
        requestAlbumInfo: async function(albumId) {
            try {
                const sf = getStorefront();
                const cleanId = String(albumId).split('?')[0];
                const appleData = await fetchAppleCatalogApi('/v1/catalog/' + sf + '/albums/' + cleanId);
                if (appleData && appleData.data && appleData.data[0]) {
                    const attr = appleData.data[0].attributes || {};
                    if (albumInfoCallback) {
                        albumInfoCallback({
                            audioTraits: attr.audioTraits || [],
                            isMasteredForItunes: Boolean(attr.isMasteredForItunes)
                        });
                    }
                    return;
                }
                const data = await gmFetchJson('/api/parse?q=' + encodeURIComponent(window.location.href) + '&lightweight=1&sf=' + encodeURIComponent(sf));
                if (albumInfoCallback && data) {
                    albumInfoCallback({
                        audioTraits: data.audioTraits || [],
                        isMasteredForItunes: (data.audioTraits || []).includes('adm')
                    });
                }
            } catch (e) {}
        },
        onAlbumQualityResult: function(cb) {
            albumQualityCallback = cb;
        },
        requestAlbumTracksQuality: async function(albumId) {
            try {
                const sf = getStorefront();
                const albumData = await gmFetchJson('/api/parse?q=' + encodeURIComponent(window.location.href) + '&lightweight=1&sf=' + encodeURIComponent(sf));
                const tracks = (albumData && albumData.tracks) || [];
                const qualities = new Array(tracks.length).fill('检测中...');
                if (albumQualityCallback) albumQualityCallback(qualities.slice());

                for (const [i, trackItem] of tracks.entries()) {
                    try {
                        const tData = await gmFetchJson('/api/parse?q=' + encodeURIComponent(trackItem.rawUrl || trackItem.id) + '&lightweight=0&sf=' + encodeURIComponent(sf));
                        const heavyTrack = (tData && tData.tracks && tData.tracks[0]) || {};
                        qualities[i] = heavyTrack.label || '未知音质';
                    } catch (err) {
                        qualities[i] = '获取失败';
                    }
                    document.querySelectorAll('.ame-track-quality').forEach(function(el) { el.remove(); });
                    if (albumQualityCallback) albumQualityCallback(qualities.slice());
                }
            } catch (e) {
                console.error('[AM Helper] 检查曲目音质失败:', e);
            }
        },
        navigateBack: function() { window.history.back(); },
        navigateFwd: function() { window.history.forward(); },
        refreshPage: function() { window.location.reload(); }
    };

    window.desktopApp = appBridge;
    pageWindow.desktopApp = appBridge;

    const CONFIG = {
        ALBUM_HEADER_ACTIONS: '.primary-actions',
        ARTIST_HEADER_PLAY_BTN: 'span.artist-header__play-button',
        TRACK_ROW_CONTROLS: '.songs-list-row__controls',
        CARD_ARTWORK: 'div[data-testid="artwork-component"]',
        VIDEO_WRAPPER: 'div[data-testid="vertical-video-artwork-wrapper"]'
    };
    const MAIN_BTN_CONTAINER_ID = 'custom-main-button-container';

    const badgeStyle = document.createElement('style');
    badgeStyle.textContent = [
        'body { padding-bottom: 45px !important; }',
        '.custom-button-container { display: inline-flex; align-items: center; gap: 10px; margin-left: 10px; vertical-align: middle; flex-shrink: 0; }',
        '.custom-dl-btn { border: none !important; border-radius: 50px !important; font-weight: bold !important; cursor: pointer !important; transition: transform 0.2s ease, background-color 0.2s ease !important; line-height: 1.2 !important; display: inline-flex !important; align-items: center; gap: 8px; z-index: 9999; white-space: nowrap; }',
        '.custom-dl-btn:hover:not(:disabled) { transform: scale(1.05); background-color: #ffca28 !important; }',
        '.custom-dl-btn:disabled { opacity: 0.5; cursor: not-allowed !important; }',
        '.custom-dl-btn svg { width: 18px; height: 18px; }',
        '.dl-btn-green { background-color: #1DB954 !important; color: black !important; }',
        '.dl-btn-green:hover:not(:disabled) { background-color: #ffca28 !important; }',
        '.dl-btn-green svg { fill: black; }',
        '.dl-btn-red { background-color: #e74c3c !important; color: black !important; }',
        '.dl-btn-red:hover:not(:disabled) { background-color: #ffca28 !important; }',
        '.dl-btn-red svg { fill: black; }',
        '.main-dl-btn { padding: 8px 16px !important; font-size: 14px !important; }',
        '.track-dl-btn { padding: 6px !important; gap: 0 !important; border-radius: 50% !important; margin-left: -8px !important; margin-right: 8px !important; }',
        '.track-dl-btn svg { width: 16px; height: 16px; margin: 2px; }',
        '.track-dl-btn span { display: none; }',
        '.card-dl-container { opacity: 1 !important; display: flex; justify-content: center; pointer-events: none; padding: 8px; z-index: 99; }',
        '.card-dl-container .custom-dl-btn { pointer-events: auto !important; padding: 6px !important; gap: 0 !important; border-radius: 50% !important; margin-left: 0 !important; margin-right: 0 !important; border: 2px solid black !important; }',
        '.card-dl-container .custom-dl-btn svg { width: 16px !important; height: 16px !important; margin: 2px !important; }',
        '.card-dl-container .custom-dl-btn span { display: none !important; }',
        '.ame-track-quality { font-size: 10px; color: var(--systemSecondary); margin-left: 8px; line-height: 1.4; text-align: left; white-space: pre-wrap; font-family: monospace; }',
        '.songs-list-row__song-wrapper { display: flex; align-items: center; }',
        '.navigation-items__header[data-ame]{border-radius:6px;font-size:10px;font-weight:600;letter-spacing:0;line-height:1.3;margin:0 20px -3px;padding:4px 6px;color:var(--systemSecondary)}',
        '.navigation-items__list[data-ame]{font-size:15px;padding:0 25px 9px;font-weight:400;letter-spacing:0}',
        '.navigation-item[data-ame]{margin-bottom:1px;height:32px;padding:4px;position:relative;border-radius:6px;--linkHoverTextDecoration: none}',
        '.navigation-item__link[data-ame]{align-items:center;border-radius:6px;box-sizing:content-box;-moz-column-gap:8px;column-gap:8px;display:flex;height:100%;margin:-3px;padding:3px;width:100%;font-size:.8rem;cursor:pointer}',
        '.navigation-item__link[data-ame] svg{width:24px;height:24px;fill:var(--systemSecondary);background-color:transparent;display:inline-block;flex-shrink:0}',
        '.ame-album-badges-container { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 1em; margin-bottom: 0.5em; }',
        '.ame-badge-text { display: inline-block; font-size: 10px; font-weight: 600; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 3px 7px; border-radius: 4px; background-color: transparent; color: var(--systemSecondary); border: 1px solid var(--systemSecondary); text-transform: uppercase; letter-spacing: 0.5px; line-height: 1.2; }',
        '.am-status-toast { position: fixed; bottom: 0; left: 50%; width: 90%; max-width: 1100px; background-color: #282828; color: #FFFFFF; border: 1px solid #4a4a4a; border-radius: 12px 12px 0 0; box-shadow: 0 -4px 20px rgba(0,0,0,0.7); z-index: 999999; padding: 10px 25px; box-sizing: border-box; transform: translate(-50%, 120%); transition: transform 0.3s ease-in-out; display: flex; align-items: center; justify-content: space-between; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }',
        '.am-status-toast.show { transform: translate(-50%, 0); }',
        '.am-status-toast.minimized { transform: translate(-50%, 100%); }',
        '.am-taskbar-left { display: flex; align-items: center; min-width: 80px; position: relative; }',
        '.am-queue-badge { background: rgba(255, 202, 40, 0.15); border: 1px solid #ffca28; color: #ffca28; font-weight: bold; font-size: 14px; padding: 4px 12px; border-radius: 16px; cursor: pointer; user-select: none; }',
        '.am-queue-popup { display: none; position: absolute; bottom: 50px; left: 0; width: 320px; max-height: 240px; overflow-y: auto; background-color: #33333d; border: 1px solid #4a4a4a; border-radius: 8px; box-shadow: 0 -4px 15px rgba(0,0,0,0.5); padding: 10px; z-index: 1000000; }',
        '.am-queue-popup.open { display: block; }',
        '.am-queue-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 6px; border-bottom: 1px solid #4a4a4a; font-size: 12px; text-align: left; }',
        '.am-queue-item-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 10px; color: #fff; }',
        '.am-queue-cancel-btn { background-color: #e53935; color: white; border: none; border-radius: 4px; padding: 3px 8px; cursor: pointer; font-size: 12px; flex-shrink: 0; }',
        '.am-taskbar-center { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; overflow: hidden; padding: 0 15px; }',
        '.am-taskbar-row1 { font-weight: bold; font-size: 14px; color: #FFFFFF; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }',
        '.am-taskbar-row2 { font-size: 12px; color: #B3B3B3; display: flex; gap: 18px; justify-content: center; align-items: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; font-family: monospace; }',
        '.am-taskbar-right { display: flex; align-items: center; gap: 10px; min-width: 80px; justify-content: flex-end; }',
        '.am-taskbar-cancel-btn { padding: 5px 12px; background: #e53935; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }',
        '.am-taskbar-toggle-btn { position: absolute; top: -28px; right: 25px; background-color: #282828; color: #ffca28; border: 1px solid #4a4a4a; border-bottom: none; border-radius: 8px 8px 0 0; padding: 4px 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; }',
        '.am-taskbar-toggle-btn svg { width: 18px; height: 18px; fill: currentColor; pointer-events: none; }',
        '.am-taskbar-total-progress-fill { display: block; position: absolute; bottom: 0; left: 0; height: 3px; background-color: #ffca28; transition: width 0.2s ease; width: 0%; z-index: 1; }'
    ].join('\n');
    document.head.appendChild(badgeStyle);

    function waitForElement(selector, options) {
        return new Promise(function(resolve) {
            const waitSel = options ? options.waitSelector : undefined;
            const timeout = (options && options.timeout !== undefined) ? options.timeout : 3000;
            if (timeout !== 0) {
                const existing = document.querySelector(selector);
                if (existing) {
                    resolve(existing);
                    return;
                }
            }
            let obs = null;
            const timer = setTimeout(function() {
                if (timeout !== 0 && obs) {
                    obs.disconnect();
                    resolve(null);
                }
            }, timeout);
            obs = new MutationObserver(function(mutations) {
                for (const m of mutations) {
                    for (const node of Array.from(m.addedNodes)) {
                        if (node instanceof Element && node.matches(waitSel || selector)) {
                            if (timeout !== 0) {
                                obs.disconnect();
                                clearTimeout(timer);
                            }
                            resolve(waitSel ? document.querySelector(selector) : node);
                            return;
                        }
                    }
                }
            });
            obs.observe(document.body, { childList: true, subtree: true });
        });
    }

    function createSidebarItem(labelText, svgBox, svgPaths) {
        const li = createEl('li', 'ame-sidebar-button navigation-item');
        li.setAttribute('data-ame', '');
        const a = createEl('a', 'navigation-item__link');
        a.setAttribute('tabindex', '0');
        a.setAttribute('data-ame', '');
        const svg = createSvgIcon(svgBox, svgPaths);
        svg.setAttribute('slot', 'app-icon');
        const span = createEl('span', '', labelText);
        a.appendChild(svg);
        a.appendChild(span);
        li.appendChild(a);
        return li;
    }

    async function addSidebarMenuItem(itemEl) {
        await waitForElement('amp-chrome-player');
        let refLi = document.querySelector('#ame-sidebar');
        if (!refLi) {
            const scrollContainer = document.querySelector('.navigation__scrollable-container');
            if (!scrollContainer) return;
            const wrapper = createEl('div', 'navigation-items');
            wrapper.setAttribute('data-ame', '');
            const header = createEl('div', 'navigation-items__header');
            header.setAttribute('data-ame', '');
            header.appendChild(createEl('span', '', 'Ame'));
            const listEl = createEl('ul', 'navigation-items__list');
            listEl.id = 'ame-sidebar-list';
            listEl.setAttribute('data-ame', '');
            refLi = createEl('li', '');
            refLi.id = 'ame-sidebar';
            refLi.style.display = 'none';
            listEl.appendChild(refLi);
            wrapper.appendChild(header);
            wrapper.appendChild(listEl);
            scrollContainer.appendChild(wrapper);
        }
        const parentList = refLi.parentElement;
        if (parentList && !parentList.contains(itemEl)) {
            parentList.appendChild(itemEl);
        }
    }

    const ALBUM_ROUTE_PATTERN = '[a-z]{2}/album/(.+/)?.+';
    const routeRegistry = {};

    function checkRoutes() {
        for (const entry of Object.values(routeRegistry)) {
            const callbacks = entry.pattern.test(location.pathname) ? entry.onCallbacks : entry.offCallbacks;
            for (const fn of callbacks) fn();
        }
    }

    function getRouteEntry(patternStr) {
        const regex = new RegExp('^/' + patternStr.replaceAll('/', '\\/') + END_CHAR);
        let entry = routeRegistry[patternStr];
        if (!entry) {
            entry = { pattern: regex, onCallbacks: [], offCallbacks: [] };
            routeRegistry[patternStr] = entry;
        }
        return entry;
    }

    function onAlbumRoute(fn) {
        const entry = getRouteEntry(ALBUM_ROUTE_PATTERN);
        const matched = entry.pattern.test(location.pathname);
        entry.onCallbacks.push(fn);
        if (matched) fn();
    }

    function offAlbumRoute(fn) {
        const entry = getRouteEntry(ALBUM_ROUTE_PATTERN);
        const matched = entry.pattern.test(location.pathname);
        entry.offCallbacks.push(fn);
        if (!matched) fn();
    }

    const btnCheckQuality = createSidebarItem(
        '检查曲目音质',
        '0 0 48 48',
        ['M29.75 33.4h2.5v-3.25h2.05q.7 0 1.2-.475T36 28.5v-8.95q0-.7-.5-1.2t-1.2-.5H28q-.7 0-1.35.5-.65.5-.65 1.2v8.95q0 .7.65 1.175.65.475 1.35.475h1.75ZM12 30.15h2.5V25.7h5v4.45H22v-12.3h-2.5v5.35h-5v-5.35H12Zm16.5-2.5v-7.3h5v7.3ZM7 40q-1.2 0-2.1-.9Q4 38.2 4 37V11q0-1.2.9-2.1Q5.8 8 7 8h34q1.2 0 2.1.9.9.9.9 2.1v26q0 1.2-.9 2.1-.9.9-2.1.9Zm0-3h34V11H7v26Zm0 0V11v26Z']
    );

    const btnSearchCovers = createSidebarItem(
        'Search Covers',
        '0 0 48 48',
        ['M24 44q-4.1 0-7.75-1.575-3.65-1.575-6.375-4.3-2.725-2.725-4.3-6.375Q4 28.1 4 24q0-4.25 1.6-7.9 1.6-3.65 4.375-6.35 2.775-2.7 6.5-4.225Q20.2 4 24.45 4q3.95 0 7.5 1.325T38.175 9q2.675 2.35 4.25 5.575Q44 17.8 44 21.65q0 5.4-3.15 8.525T32.5 33.3h-3.75q-.9 0-1.55.7t-.65 1.55q0 1.35.725 2.3.725.95.725 2.2 0 1.9-1.05 2.925T24 44Zm0-20Zm-11.65 1.3q1 0 1.75-.75t.75-1.75q0-1-.75-1.75t-1.75-.75q-1 0-1.75.75t-.75 1.75q0 1 .75 1.75t1.75.75Zm6.3-8.5q1 0 1.75-.75t.75-1.75q0-1-.75-1.75t-1.75-.75q-1 0-1.75.75t-.75 1.75q0 1 .75 1.75t1.75.75Zm10.7 0q1 0 1.75-.75t.75-1.75q0-1-.75-1.75t-1.75-.75q-1 0-1.75.75t-.75 1.75q0 1 .75 1.75t1.75.75Zm6.55 8.5q1 0 1.75-.75t.75-1.75q0-1-.75-1.75t-1.75-.75q-1 0-1.75.75t-.75 1.75q0 1 .75 1.75t1.75.75ZM24 41q.55 0 .775-.225.225-.225.225-.725 0-.7-.725-1.3-.725-.6-.725-2.65 0-2.3 1.5-4.05t3.8-1.75h3.65q3.8 0 6.15-2.225Q41 25.85 41 21.65q0-6.6-5-10.625T24.45 7q-7.3 0-12.375 4.925T7 24q0 7.05 4.975 12.025Q16.95 41 24 41Z']
    );

    const btnSeedMusicBrainz = createSidebarItem(
        'Seed MusicBrainz',
        '0 -960 960 960',
        ['M440-120v-319q-64 0-123-24.5T213-533q-45-45-69-104t-24-123v-80h80q63 0 122 24.5T426-746q31 31 51.5 68t31.5 79q5-7 11-13.5t13-13.5q45-45 104-69.5T760-720h80v80q0 64-24.5 123T746-413q-45 45-103.5 69T520-320v200h-80Zm0-400q0-48-18.5-91.5T369-689q-34-34-77.5-52.5T200-760q0 48 18 92t52 78q34 34 78 52t92 18Zm80 120q48 0 91.5-18t77.5-52q34-34 52.5-78t18.5-92q-48 0-92 18.5T590-569q-34 34-52 77.5T520-400Zm0 0Zm-80-120Z']
    );

    let lastKuClickTime = 0;

    function injectSidebarButtons() {
        const reSingle = new RegExp(' - Single' + END_CHAR, 'i');
        const reEp = new RegExp(' - EP' + END_CHAR, 'i');

        btnSearchCovers.addEventListener('click', function() {
            const subEl = document.querySelector('.headings__subtitles a');
            const titleEl = document.querySelector('.headings__title');
            if (!titleEl) return;
            const artist = subEl ? subEl.innerText.trim() : '';
            const album = titleEl.innerText.trim().replace(reSingle, '').replace(reEp, '');
            const params = new URLSearchParams();
            if (artist) params.set('artist', artist);
            params.set('album', album);
            window.open('https://covers.musichoarders.xyz?' + params.toString(), '_blank');
        });

        btnSeedMusicBrainz.addEventListener('click', function() {
            window.open('https://seed.musichoarders.xyz?identifier=' + encodeURIComponent(location.href), '_blank');
        });

        btnCheckQuality.addEventListener('click', function() {
            const now = Date.now();
            if (Math.max(0, now - lastKuClickTime - 60000) === 0 && lastKuClickTime !== 0) return;
            lastKuClickTime = now;

            const trackList = document.querySelector('[data-testid="track-list-item"]');
            if (trackList) {
                const pathParts = window.location.pathname.split('/');
                const albumId = pathParts.pop();
                if (albumId && pathParts.includes('album')) {
                    qualityDataCache = [];
                    document.querySelectorAll('.ame-track-quality').forEach(function(el) { el.remove(); });
                    appBridge.requestAlbumTracksQuality(albumId);
                }
            }
        });

        onAlbumRoute(function() {
            addSidebarMenuItem(btnCheckQuality);
            addSidebarMenuItem(btnSearchCovers);
            addSidebarMenuItem(btnSeedMusicBrainz);
        });

        offAlbumRoute(function() {
            document.querySelectorAll('.ame-sidebar-button').forEach(function(el) { el.remove(); });
        });

        checkRoutes();
    }

    function injectAlbumBadges() {
        appBridge.onAlbumInfoResult(function(data) {
            if (!data) return;

            waitForElement('.headings__metadata-bottom').then(function(metaEl) {
                if (!metaEl) return;

                const oldBadges = document.querySelector('.ame-album-badges-container');
                if (oldBadges) oldBadges.remove();

                const traits = (data.audioTraits || []).slice();
                if (data.isMasteredForItunes) {
                    traits.push('adm');
                }
                if (traits.length === 0) return;

                const container = createEl('p', 'ame-album-badges-container');
                const badgeMap = [
                    ['lossy-stereo', 'AAC'],
                    ['lossless', 'Lossless'],
                    ['hi-res-lossless', 'Hi-Res'],
                    ['atmos', 'Atmos'],
                    ['adm', 'Master'],
                    ['spatial', 'Spatial']
                ];

                badgeMap.forEach(function(pair) {
                    if (traits.includes(pair[0])) {
                        container.appendChild(createEl('span', 'ame-badge-text', pair[1]));
                    }
                });

                metaEl.after(container);
            });
        });

        onAlbumRoute(function() {
            const pathParts = window.location.pathname.split('/');
            const albumId = pathParts.pop();

            if (albumId && pathParts.includes('album')) {
                const oldBadges = document.querySelector('.ame-album-badges-container');
                if (oldBadges) oldBadges.remove();
                appBridge.requestAlbumInfo(albumId);
            }
        });

        offAlbumRoute(function() {
            const oldBadges = document.querySelector('.ame-album-badges-container');
            if (oldBadges) oldBadges.remove();
        });
    }

    const DOWNLOAD_ICON_PATH = 'M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z';

    function createButtons(url, details, isSmall, downloadType, customText, colorClass) {
        const qualityType = downloadType || 'hires';
        const label = customText || '下载';
        const themeClass = colorClass || 'dl-btn-green';
        const btnSizeClass = isSmall ? 'track-dl-btn' : 'main-dl-btn';

        const button = createEl('button', 'custom-dl-btn ' + themeClass + ' ' + btnSizeClass);
        button.title = isSmall ? '下载' : ('下载 (' + label + ')');
        button.appendChild(createSvgIcon('0 0 24 24', [DOWNLOAD_ICON_PATH]));

        if (!isSmall) {
            button.appendChild(createEl('span', '', label));
        }

        const stopAllClicks = function(e) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        };

        button.addEventListener('pointerdown', stopAllClicks, { capture: true });
        button.addEventListener('pointerup', stopAllClicks, { capture: true });
        button.addEventListener('click', function(e) {
            stopAllClicks(e);
            appBridge.download(url, details, qualityType, button);
        }, { capture: true });
        return button;
    }

    function injectAlbumHeaderButton(container) {
        if (container.querySelector('#' + MAIN_BTN_CONTAINER_ID)) return;
        const h1El = document.querySelector('h1');
        const artistLinkEl = document.querySelector('.product-header__identity a');
        const details = {
            name: h1El ? h1El.textContent.trim() : document.title,
            artist: artistLinkEl ? artistLinkEl.textContent.trim() : '未知歌手'
        };
        const url = new URL(window.location.href).href;

        const buttonContainer = createEl('div', 'custom-button-container');
        buttonContainer.id = MAIN_BTN_CONTAINER_ID;

        const hiresBtn = createButtons(url, details, false, 'hires', 'Hi-Res', 'dl-btn-green');
        const losslessBtn = createButtons(url, details, false, 'lossless', 'Lossless', 'dl-btn-green');
        const atmosBtn = createButtons(url, details, false, 'atmos', 'Atmos', 'dl-btn-red');

        buttonContainer.appendChild(hiresBtn);
        buttonContainer.appendChild(losslessBtn);
        buttonContainer.appendChild(atmosBtn);

        container.appendChild(buttonContainer);
        container.classList.add('custom-buttons-added');
    }

    function injectArtistHeaderButton(playButtonSpan) {
        const nameEl = document.querySelector('h1[data-testid="artist-header-name"]');
        const name = nameEl ? nameEl.textContent.trim() : '';
        if (!name) return;
        const details = { name: name, artist: name };
        const url = new URL(window.location.href).href;
        const buttonEl = createButtons(url, details, false, 'hires', '下载', 'dl-btn-green');
        const buttonContainer = createEl('div', 'custom-button-container');
        buttonContainer.id = MAIN_BTN_CONTAINER_ID;
        buttonContainer.appendChild(buttonEl);
        playButtonSpan.parentNode.insertBefore(buttonContainer, playButtonSpan.nextSibling);
        playButtonSpan.classList.add('custom-buttons-added');
    }

    function injectTrackButton(row) {
        const controlsContainer = row.querySelector(CONFIG.TRACK_ROW_CONTROLS);
        if (!controlsContainer) return;
        const allLinks = Array.from(row.querySelectorAll('a[data-testid="click-action"]'));
        const artistLinks = Array.from(row.querySelectorAll('[data-testid="track-title-by-line"] a'));
        const songLink = allLinks.find(function(link) { return !artistLinks.includes(link); });
        if (!songLink) return;

        const url = new URL(songLink.href, window.location.origin).href;
        const trackTitleEl = row.querySelector('[data-testid="track-title"]');
        const trackArtistEl = row.querySelector('[data-testid="track-title-by-line"]');
        const h1El = document.querySelector('h1');
        const headerArtistEl = document.querySelector('.product-header__identity a');
        const trackName = trackTitleEl ? trackTitleEl.textContent.trim() : '未知曲目';
        const trackArtist = trackArtistEl ? trackArtistEl.textContent.trim() : (headerArtistEl ? headerArtistEl.textContent.trim() : '未知歌手');
        const details = { name: trackName, artist: trackArtist, album: h1El ? h1El.textContent.trim() : '' };
        const buttonEl = createButtons(url, details, true, 'hires');
        const buttonContainer = createEl('div', 'custom-button-container');
        buttonContainer.appendChild(buttonEl);
        controlsContainer.appendChild(buttonContainer);
        row.classList.add('custom-buttons-added');
    }

    function injectCardButton(artworkElement) {
        const cardRoot = artworkElement.closest('li[class*="grid-item"], div[class*="product-card"], div[class*="product-lockup"]');
        if (!cardRoot) return;
        if (artworkElement.classList.contains('custom-buttons-added')) return;
        const link = cardRoot.querySelector('a[data-testid="product-lockup-link"]') || cardRoot.querySelector('div[class*="lockup__title"] a');
        if (!link || !link.href) return;
        const url = new URL(link.href, window.location.origin).href;
        const name = link.textContent.trim();
        let artist = '未知歌手';
        const artistEl = cardRoot.querySelector('div[class*="lockup__subtitle"]');
        if (artistEl) artist = artistEl.textContent.trim();
        const details = { name: name, artist: artist };
        const buttonEl = createButtons(url, details, true, 'hires');
        const bottomContainer = createEl('div', 'card-dl-container');
        bottomContainer.style.position = 'absolute';
        bottomContainer.style.bottom = '0';
        bottomContainer.style.left = '50%';
        bottomContainer.style.transform = 'translateX(-50%)';
        bottomContainer.style.pointerEvents = 'auto';
        bottomContainer.style.zIndex = '100';
        bottomContainer.appendChild(buttonEl);
        cardRoot.style.position = 'relative';
        cardRoot.appendChild(bottomContainer);
        artworkElement.classList.add('custom-buttons-added');
    }

    function injectVideoButton(videoWrapper) {
        if (videoWrapper.classList.contains('custom-buttons-added')) return;
        const linkEl = videoWrapper.querySelector('a[data-testid="click-action"]');
        const artworkEl = videoWrapper.querySelector('[data-testid="artwork-component"]');
        if (!linkEl || !linkEl.href || !artworkEl) return;

        const urlObj = new URL(linkEl.href, window.location.origin);
        const url = urlObj.href;

        const cardRoot = videoWrapper.closest('li[class*="grid-item"], div[class*="product-card"], div[class*="product-lockup"]');
        let name = '未知视频';
        let artist = '未知歌手';

        if (cardRoot) {
            const nameEl = cardRoot.querySelector('div[class*="lockup__title"]') || cardRoot.querySelector('a[data-testid="product-lockup-link"]');
            const artistEl = cardRoot.querySelector('div[class*="lockup__subtitle"]');
            if (nameEl) name = nameEl.textContent.trim();
            if (artistEl) artist = artistEl.textContent.trim();
        }

        if (name === '未知视频') {
            name = url.split('/').pop() || '未知视频';
        }

        const details = { name: name, artist: artist };
        const buttonEl = createButtons(url, details, true, 'hires');
        const buttonContainer = createEl('div', 'card-dl-container');
        buttonContainer.style.position = 'absolute';
        buttonContainer.style.bottom = '0';
        buttonContainer.style.left = '50%';
        buttonContainer.style.transform = 'translateX(-50%)';
        buttonContainer.style.pointerEvents = 'auto';
        buttonContainer.style.zIndex = '100';
        buttonContainer.appendChild(buttonEl);
        videoWrapper.style.position = 'relative';
        videoWrapper.appendChild(buttonContainer);
        videoWrapper.classList.add('custom-buttons-added');
        if (artworkEl) artworkEl.classList.add('custom-buttons-added');
    }

    let qualityDataCache = [];

    appBridge.onAlbumQualityResult(function(qualities) {
        qualityDataCache = qualities;
        const trackRows = document.querySelectorAll('.songs-list-row__song-wrapper');
        trackRows.forEach(function(wrapper, index) {
            if (qualities[index] && !wrapper.querySelector('.ame-track-quality')) {
                wrapper.appendChild(createEl('span', 'ame-track-quality', qualities[index]));
            }
        });
    });

    let sidebarInjected = false;
    let observerTimeout = null;

    const observer = new MutationObserver(function() {
        if (observerTimeout) clearTimeout(observerTimeout);

        observerTimeout = setTimeout(function() {
            try {
                if (!document.getElementById(MAIN_BTN_CONTAINER_ID)) {
                    const albumHeader = document.querySelector(CONFIG.ALBUM_HEADER_ACTIONS + ':not(.custom-buttons-added)');
                    if (albumHeader) injectAlbumHeaderButton(albumHeader);
                    const artistHeaderBtn = document.querySelector(CONFIG.ARTIST_HEADER_PLAY_BTN + ':not(.custom-buttons-added)');
                    if (artistHeaderBtn) injectArtistHeaderButton(artistHeaderBtn);
                }

                const trackRows = document.querySelectorAll('[data-testid="track-list-item"]:not(.custom-buttons-added)');
                trackRows.forEach(injectTrackButton);

                const cardArtworkSelector = CONFIG.CARD_ARTWORK + ':not(.custom-buttons-added)';
                document.querySelectorAll(cardArtworkSelector).forEach(injectCardButton);
                document.querySelectorAll(CONFIG.VIDEO_WRAPPER + ':not(.custom-buttons-added)').forEach(injectVideoButton);

                if (!sidebarInjected && document.querySelector('.navigation__scrollable-container')) {
                    injectSidebarButtons();
                    injectAlbumBadges();
                    sidebarInjected = true;
                }

                const trackList = document.querySelector('[data-testid="track-list-item"]');
                if (trackList && qualityDataCache.length !== 0) {
                    const trackWrappers = document.querySelectorAll('.songs-list-row__song-wrapper');
                    trackWrappers.forEach(function(wrapper, index) {
                        if (qualityDataCache[index] && !wrapper.querySelector('.ame-track-quality')) {
                            wrapper.appendChild(createEl('span', 'ame-track-quality', qualityDataCache[index]));
                        }
                    });
                }
            } catch (err) {
                console.error('[Injector.js] 注入时发生错误:', err);
            }
        }, 200);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    let oldPath = location.pathname;
    const pathObserver = new MutationObserver(function() {
        if (oldPath !== location.pathname) {
            oldPath = location.pathname;
            sidebarInjected = false;
            qualityDataCache = [];
            checkRoutes();
        }
    });
    pathObserver.observe(document.body, { childList: true, subtree: true });

    let navInjectInterval = null;

    function injectNavControls() {
        if (document.getElementById('custom-nav-container')) {
            if (navInjectInterval) clearInterval(navInjectInterval);
            return;
        }

        const logoElement = document.querySelector('[data-testid="logo"]');
        if (!logoElement) return;

        logoElement.style.display = 'flex';
        logoElement.style.alignItems = 'center';

        const navContainer = createEl('div', '');
        navContainer.id = 'custom-nav-container';
        navContainer.style.cssText = 'display: inline-flex; align-items: center; gap: 8px; margin-left: 16px; -webkit-app-region: no-drag; pointer-events: auto;';

        const btnStyle = 'background: transparent; border: none; color: #aaa; cursor: pointer; padding: 4px; border-radius: 4px; display: flex; align-items: center; justify-content: center; transition: color 0.2s, background-color 0.2s;';

        function createNavBtn(svgEl, title, onClick) {
            const btn = createEl('button', '');
            btn.title = title;
            btn.style.cssText = btnStyle;
            btn.appendChild(svgEl);
            btn.onmouseenter = function() { btn.style.color = '#fff'; btn.style.backgroundColor = 'rgba(255,255,255,0.1)'; };
            btn.onmouseleave = function() { btn.style.color = '#aaa'; btn.style.backgroundColor = 'transparent'; };

            const stopAllClicks = function(e) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            };

            btn.addEventListener('pointerdown', function(e) {
                stopAllClicks(e);
                onClick();
            }, { capture: true });

            btn.addEventListener('pointerup', stopAllClicks, { capture: true });
            btn.addEventListener('click', stopAllClicks, { capture: true });

            return btn;
        }

        const iconBack = createSvgIcon('0 0 24 24', ['M15 18l-6-6 6-6'], 20, 20, true);
        const iconFwd = createSvgIcon('0 0 24 24', ['M9 18l6-6-6-6'], 20, 20, true);
        const iconRefresh = createSvgIcon('0 0 24 24', ['M23 4v6h-6', 'M1 20v-6h6', 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15'], 18, 18, true);

        navContainer.appendChild(createNavBtn(iconBack, '后退', function() { appBridge.navigateBack(); }));
        navContainer.appendChild(createNavBtn(iconFwd, '前进', function() { appBridge.navigateFwd(); }));
        navContainer.appendChild(createNavBtn(iconRefresh, '刷新', function() { appBridge.refreshPage(); }));
        logoElement.appendChild(navContainer);

        if (navInjectInterval) clearInterval(navInjectInterval);
    }
    navInjectInterval = setInterval(injectNavControls, 1000);
    console.log('Apple Music 下载助手已加载');
})();
