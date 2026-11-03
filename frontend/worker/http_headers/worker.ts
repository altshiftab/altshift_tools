// The /http-headers analysis worker: runs altshift_web_security, compiled to WebAssembly, off the page's
// thread and under a policy of its own that may compile it. It is a classic worker so it can load the
// Go runtime glue with importScripts; both files sit beside it, and are named relative to it.

declare class Go {
    importObject: WebAssembly.Imports;
    run(instance: WebAssembly.Instance): Promise<void>;
}

// Set by the Go program's main before it parks.
declare const httpHeaders: {
    analyze(text: string): string;
};

const scope = self as unknown as DedicatedWorkerGlobalScope;

function post(message: HttpHeadersProtocol.Message): void {
    scope.postMessage(message);
}

function handle(request: HttpHeadersProtocol.Request): void {
    try {
        post({kind: "result", id: request.id, json: httpHeaders.analyze(request.text)});
    } catch (error) {
        // A Go program that has exited throws on every call; the page is told rather than left waiting.
        post({kind: "error", id: request.id, error: String(error)});
    }
}

async function start(): Promise<void> {
    importScripts("wasm_exec.js");
    const go = new Go();
    const {instance} = await WebAssembly.instantiateStreaming(fetch("http_headers.wasm"), go.importObject);
    // Running main defines httpHeaders and parks the program, which then lives as long as the worker.
    void go.run(instance);
    scope.onmessage = (event: MessageEvent<HttpHeadersProtocol.Request>) => handle(event.data);
    post({kind: "ready"});
}

start().catch((error: unknown) => post({kind: "failed", error: String(error)}));
