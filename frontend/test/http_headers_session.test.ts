import {test} from "node:test";
import assert from "node:assert/strict";

import type {Analyser} from "../src/scripts/lib/http_headers_client.ts";
import {HttpHeadersSession, viewOfReport, type ViewState} from "../src/scripts/lib/http_headers_session.ts";

const reportJson = JSON.stringify({
    findings: [
        {rule_id: "missing_strict_transport_security", level: "error", title: "The Strict-Transport-Security header is missing", header_name: "Strict-Transport-Security"},
        {rule_id: "x_frame_options_obsolete", level: "none", title: "The obsolete X-Frame-Options header is being used", header_name: "X-Frame-Options", header_value: "DENY"},
    ],
    field_count: 2,
    document: true,
});

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {promise, resolve, reject};
}

// FakeAnalyser answers each text when the test says so, so the order answers arrive in is the test's.
class FakeAnalyser implements Analyser {
    readonly asked: string[] = [];
    readonly answers: Deferred<string>[] = [];
    terminated = false;

    analyze(text: string): Promise<string> {
        this.asked.push(text);
        const answer = deferred<string>();
        this.answers.push(answer);
        return answer.promise;
    }

    terminate(): void {
        this.terminated = true;
    }
}

function session(start: () => Promise<Analyser>): {session: HttpHeadersSession; states: ViewState[]} {
    const states: ViewState[] = [];
    return {session: new HttpHeadersSession(start, state => states.push(state)), states};
}

function kinds(states: ViewState[]): string[] {
    return states.map(state => state.kind);
}

test("a paste is shown as its findings, grouped by level", async () => {
    const analyser = new FakeAnalyser();
    const {session: headersSession, states} = session(async () => analyser);

    const updated = headersSession.update("Server: nginx");
    await Promise.resolve();
    await Promise.resolve();
    analyser.answers[0].resolve(reportJson);
    await updated;

    assert.deepEqual(kinds(states), ["loading", "report"], "loading, then the report");
    const last = states.at(-1);
    assert.ok(last?.kind === "report");
    assert.equal(last.report.field_count, 2, "the fields read");
    assert.deepEqual(last.groups.map(group => group.label), ["High", "Informational"], "the groups");
    assert.deepEqual(analyser.asked, ["Server: nginx"], "the text analysed");
});

test("a blank paste is nothing to analyse, and is not sent", async () => {
    let started = 0;
    const {session: headersSession, states} = session(async () => {
        started++;
        return new FakeAnalyser();
    });

    await headersSession.update("  \n\t ");

    assert.deepEqual(states, [{kind: "idle"}], "idle");
    assert.equal(started, 0, "no analyser was started for it");
});

test("an answer to text that has since changed is dropped", async () => {
    const analyser = new FakeAnalyser();
    const {session: headersSession, states} = session(async () => analyser);
    await headersSession.start();

    const first = headersSession.update("Server: nginx");
    const second = headersSession.update("Server: nginx\nX-Frame-Options: DENY");
    await new Promise(resolve => setTimeout(resolve, 0));

    // The later edit is answered first, and the earlier answer arrives after it.
    analyser.answers[1].resolve(reportJson);
    await second;
    analyser.answers[0].resolve('{"findings":[],"field_count":1,"document":true}');
    await first;

    assert.deepEqual(kinds(states), ["report"], "only the latest text's report");
    const last = states.at(-1);
    assert.ok(last?.kind === "report");
    assert.equal(last.report.field_count, 2, "the report on the latest text");
});

test("clearing the text drops an answer still to come", async () => {
    const analyser = new FakeAnalyser();
    const {session: headersSession, states} = session(async () => analyser);
    await headersSession.start();

    const pending = headersSession.update("Server: nginx");
    await headersSession.update("");
    await new Promise(resolve => setTimeout(resolve, 0));
    analyser.answers[0].resolve(reportJson);
    await pending;

    assert.deepEqual(kinds(states), ["idle"], "the cleared text stays cleared");
});

test("what the page shows when the analysis cannot be had", async () => {
    const testCases: {name: string; answer: (analyser: FakeAnalyser) => void; expected: ViewState}[] = [
        {
            name: "text that is not headers",
            answer: analyser => analyser.answers[0].resolve('{"findings":[],"error_kind":"parse","error":"The text is not HTTP response headers: malformed MIME header: missing colon: \\"hello\\"."}'),
            expected: {kind: "invalid", message: "The text is not HTTP response headers: malformed MIME header: missing colon: \"hello\"."},
        },
        {
            name: "a status line and no fields, as partway through typing",
            answer: analyser => analyser.answers[0].resolve('{"findings":[],"error_kind":"empty","error":"There are no header fields to analyse."}'),
            expected: {kind: "idle"},
        },
        {
            name: "the analysis failing",
            answer: analyser => analyser.answers[0].resolve('{"findings":[],"error_kind":"internal","error":"analyze: boom"}'),
            expected: {kind: "failed", message: "analyze: boom"},
        },
        {
            name: "the worker failing",
            answer: analyser => analyser.answers[0].reject(new Error("The analyser stopped: RuntimeError: unreachable")),
            expected: {kind: "failed", message: "The analyser stopped: RuntimeError: unreachable"},
        },
        {
            name: "an answer that is not a report",
            answer: analyser => analyser.answers[0].resolve("<html>"),
            expected: {kind: "failed", message: "Unexpected token '<', \"<html>\" is not valid JSON"},
        },
    ];

    for (const testCase of testCases) {
        const analyser = new FakeAnalyser();
        const {session: headersSession, states} = session(async () => analyser);
        await headersSession.start();

        const updated = headersSession.update("hello");
        await new Promise(resolve => setTimeout(resolve, 0));
        testCase.answer(analyser);
        await updated;

        assert.deepEqual(states.at(-1), testCase.expected, testCase.name);
    }
});

test("an analyser that does not start is reported, and not started again for every edit", async () => {
    let started = 0;
    const {session: headersSession, states} = session(() => {
        started++;
        return Promise.reject(new Error("The analyser did not start: CompileError: wasm-unsafe-eval"));
    });

    await headersSession.update("Server: nginx");
    await headersSession.update("Server: nginx\n");

    assert.deepEqual(states.at(-1), {kind: "failed", message: "The analyser did not start: CompileError: wasm-unsafe-eval"}, "the failure");
    assert.equal(started, 1, "started once");
});

test("closing stops the analyser and shows nothing more", async () => {
    const analyser = new FakeAnalyser();
    const {session: headersSession, states} = session(async () => analyser);
    await headersSession.start();

    const pending = headersSession.update("Server: nginx");
    headersSession.close();
    await new Promise(resolve => setTimeout(resolve, 0));
    analyser.answers[0].resolve(reportJson);
    await pending;
    await headersSession.update("X-Frame-Options: DENY");

    assert.equal(analyser.terminated, true, "the analyser is stopped");
    assert.deepEqual(states, [], "nothing shown after closing");
});

test("viewOfReport", () => {
    const testCases: {name: string; report: Parameters<typeof viewOfReport>[0]; expectedKind: ViewState["kind"]}[] = [
        {name: "findings", report: {findings: [], field_count: 1, document: true}, expectedKind: "report"},
        {name: "empty", report: {findings: [], field_count: 0, document: false, error_kind: "empty", error: "e"}, expectedKind: "idle"},
        {name: "parse", report: {findings: [], field_count: 0, document: false, error_kind: "parse", error: "e"}, expectedKind: "invalid"},
        {name: "internal", report: {findings: [], field_count: 0, document: false, error_kind: "internal", error: "e"}, expectedKind: "failed"},
    ];

    for (const testCase of testCases) {
        assert.equal(viewOfReport(testCase.report).kind, testCase.expectedKind, testCase.name);
    }
});
