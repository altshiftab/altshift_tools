/// <reference path="../worker/http_headers/protocol.d.ts" />
import {test} from "node:test";
import assert from "node:assert/strict";

import {HttpHeadersClient, type WorkerLike} from "../src/scripts/lib/http_headers_client.ts";

type MessageListener = (event: {data: HttpHeadersProtocol.Message}) => void;
type ErrorListener = (event: {message?: string}) => void;

// FakeWorker delivers messages the way a worker does: asynchronously, and as structured clones, so
// nothing the client holds is shared with the worker side.
class FakeWorker implements WorkerLike {
    readonly received: HttpHeadersProtocol.Request[] = [];
    terminated = false;
    readonly #messageListeners: MessageListener[] = [];
    readonly #errorListeners: ErrorListener[] = [];
    readonly #answer: (request: HttpHeadersProtocol.Request) => HttpHeadersProtocol.Message | undefined;

    constructor(answer: (request: HttpHeadersProtocol.Request) => HttpHeadersProtocol.Message | undefined = () => undefined) {
        this.#answer = answer;
    }

    addEventListener(type: "message", listener: MessageListener): void;
    addEventListener(type: "error", listener: ErrorListener): void;
    addEventListener(type: "message" | "error", listener: MessageListener | ErrorListener): void {
        if (type === "message") {
            this.#messageListeners.push(listener as MessageListener);
        } else {
            this.#errorListeners.push(listener as ErrorListener);
        }
    }

    postMessage(message: HttpHeadersProtocol.Request): void {
        const delivered = structuredClone(message);
        this.received.push(delivered);
        const answer = this.#answer(delivered);
        if (answer !== undefined) {
            this.emit(answer);
        }
    }

    terminate(): void {
        this.terminated = true;
    }

    emit(message: HttpHeadersProtocol.Message): void {
        setTimeout(() => {
            const data = structuredClone(message);
            for (const listener of this.#messageListeners) {
                listener({data});
            }
        }, 0);
    }

    // crash fires an error event; without text it is the plain Event of a script that failed to load.
    crash(text?: string): void {
        setTimeout(() => {
            for (const listener of this.#errorListeners) {
                listener(text === undefined ? {} : {message: text});
            }
        }, 0);
    }
}

async function startedClient(
    answer?: (request: HttpHeadersProtocol.Request) => HttpHeadersProtocol.Message | undefined,
): Promise<{client: HttpHeadersClient; worker: FakeWorker}> {
    const worker = new FakeWorker(answer);
    const started = HttpHeadersClient.start(() => worker);
    worker.emit({kind: "ready"});
    return {client: await started, worker};
}

// echo answers each request with JSON naming the text it was asked about.
function echo(request: HttpHeadersProtocol.Request): HttpHeadersProtocol.Message {
    return {kind: "result", id: request.id, json: JSON.stringify({text: request.text})};
}

test("an analysis is answered with the JSON the worker returns for it", async () => {
    const {client, worker} = await startedClient(echo);

    const json = await client.analyze("Server: nginx");

    assert.deepEqual(JSON.parse(json), {text: "Server: nginx"}, "the answer for the text");
    assert.deepEqual(worker.received, [{id: 1, text: "Server: nginx"}], "the request the worker saw");
});

test("answers are matched to their requests, whatever order they come in", async () => {
    const {client, worker} = await startedClient();

    const first = client.analyze("first");
    const second = client.analyze("second");
    worker.emit({kind: "result", id: 2, json: '"second"'});
    worker.emit({kind: "result", id: 1, json: '"first"'});

    assert.deepEqual(await Promise.all([first, second]), ['"first"', '"second"'], "each answer reaches its request");
});

test("starting and failing", async () => {
    const testCases: {name: string; run: () => Promise<unknown>; expected: RegExp}[] = [
        {
            name: "the module does not load",
            run: () => {
                const worker = new FakeWorker();
                const started = HttpHeadersClient.start(() => worker);
                worker.emit({kind: "failed", error: "CompileError: WebAssembly.instantiateStreaming(): wasm-unsafe-eval"});
                return started;
            },
            expected: /^The analyser did not start: CompileError/,
        },
        {
            name: "the worker script does not load",
            run: () => {
                const worker = new FakeWorker();
                const started = HttpHeadersClient.start(() => worker);
                worker.crash();
                return started;
            },
            expected: /^The analyser stopped: its script could not be loaded$/,
        },
        {
            name: "the worker is refused",
            run: () => HttpHeadersClient.start(() => {
                throw new TypeError("This document requires 'TrustedScriptURL' assignment.");
            }),
            expected: /^The analyser did not start: This document requires 'TrustedScriptURL'/,
        },
        {
            name: "the analysis throws in the worker",
            run: async () => {
                const {client} = await startedClient(request => ({kind: "error", id: request.id, error: "Error: Go program has already exited"}));
                return client.analyze("Server: nginx");
            },
            expected: /^The analysis failed: Error: Go program has already exited$/,
        },
        {
            name: "the worker dies with an analysis outstanding",
            run: async () => {
                const {client, worker} = await startedClient();
                const pending = client.analyze("Server: nginx");
                worker.crash("RuntimeError: unreachable");
                return pending;
            },
            expected: /^The analyser stopped: RuntimeError: unreachable$/,
        },
        {
            name: "an analysis asked of a dead worker",
            run: async () => {
                const {client, worker} = await startedClient(echo);
                worker.crash("RuntimeError: unreachable");
                await new Promise(resolve => setTimeout(resolve, 0));
                return client.analyze("Server: nginx");
            },
            expected: /^The analyser stopped: RuntimeError: unreachable$/,
        },
    ];

    for (const testCase of testCases) {
        await assert.rejects(testCase.run(), {message: testCase.expected}, testCase.name);
    }
});

test("terminating stops the worker and what was outstanding", async () => {
    const {client, worker} = await startedClient();
    const pending = client.analyze("Server: nginx");

    client.terminate();

    assert.equal(worker.terminated, true, "the worker is stopped");
    await assert.rejects(pending, {message: "The analyser was stopped."}, "the outstanding analysis");
    await assert.rejects(client.analyze("again"), {message: "The analyser was stopped."}, "a later analysis");
});
