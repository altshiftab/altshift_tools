/// <reference path="../../../worker/http_headers/protocol.d.ts" />

// The part of a Worker the client uses, down to the event fields it reads, so tests can stand in for one.
export interface WorkerLike {
    postMessage(message: HttpHeadersProtocol.Request): void;
    addEventListener(type: "message", listener: (event: {data: HttpHeadersProtocol.Message}) => void): void;
    addEventListener(type: "error", listener: (event: {message?: string}) => void): void;
    terminate(): void;
}

// Analyser is what the page asks for a report: the JSON the Go analysis returns on a header block.
export interface Analyser {
    analyze(text: string): Promise<string>;
    terminate(): void;
}

interface Pending {
    resolve: (json: string) => void;
    reject: (error: Error) => void;
}

// HttpHeadersClient runs analyses in the worker, matching each answer to its request.
export class HttpHeadersClient implements Analyser {
    readonly #worker: WorkerLike;
    readonly #pending = new Map<number, Pending>();
    #nextId = 1;
    #failure: Error | undefined;

    private constructor(worker: WorkerLike) {
        this.#worker = worker;
    }

    // start creates the worker and resolves once it has loaded the analysis, or rejects if it cannot.
    static start(createWorker: () => WorkerLike): Promise<HttpHeadersClient> {
        let worker: WorkerLike;
        try {
            worker = createWorker();
        } catch (error) {
            // A refused Trusted Types policy or worker URL throws; the caller awaits a promise, so it
            // rejects instead.
            return Promise.reject(new Error(`The analyser did not start: ${error instanceof Error ? error.message : String(error)}`));
        }

        const client = new HttpHeadersClient(worker);
        return new Promise((resolve, reject) => {
            let ready = false;
            worker.addEventListener("message", event => {
                const message = event.data;
                switch (message.kind) {
                    case "ready":
                        ready = true;
                        resolve(client);
                        return;
                    case "failed":
                        client.#fail(new Error(`The analyser did not start: ${message.error}`));
                        reject(client.#failure);
                        return;
                    case "result":
                    case "error":
                        client.#settle(message);
                }
            });
            worker.addEventListener("error", event => {
                // A worker script that fails to load -- refused by a policy, or not served -- fires a
                // plain Event, which has no message.
                client.#fail(new Error(`The analyser stopped: ${event.message ?? "its script could not be loaded"}`));
                if (!ready) {
                    reject(client.#failure);
                }
            });
        });
    }

    analyze(text: string): Promise<string> {
        if (this.#failure !== undefined) {
            return Promise.reject(this.#failure);
        }

        const id = this.#nextId++;
        return new Promise((resolve, reject) => {
            this.#pending.set(id, {resolve, reject});
            this.#worker.postMessage({id, text});
        });
    }

    terminate(): void {
        this.#worker.terminate();
        this.#fail(new Error("The analyser was stopped."));
    }

    #settle(message: Extract<HttpHeadersProtocol.Message, {id: number}>): void {
        const pending = this.#pending.get(message.id);
        if (pending === undefined) {
            return;
        }

        this.#pending.delete(message.id);
        if (message.kind === "error") {
            pending.reject(new Error(`The analysis failed: ${message.error}`));
            return;
        }

        pending.resolve(message.json);
    }

    #fail(error: Error): void {
        this.#failure ??= error;
        for (const pending of this.#pending.values()) {
            pending.reject(this.#failure);
        }
        this.#pending.clear();
    }
}
