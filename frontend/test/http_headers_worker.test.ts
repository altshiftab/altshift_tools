import {afterEach, test} from "node:test";
import assert from "node:assert/strict";

import {installTrustedTypes, installWorker, restoreBrowserStubs} from "./browser_stubs.ts";
import {
    createHttpHeadersWorker,
    httpHeadersWorkerPolicyName,
    httpHeadersWorkerUrl,
    workerScriptUrl,
} from "../src/scripts/lib/http_headers_worker.ts";

afterEach(restoreBrowserStubs);

// The module makes its policy once and keeps it, as a page must, so the cases run in order in one test:
// a browser without Trusted Types first, then one enforcing them.
test("the worker is started through a policy that vouches for its URL alone", () => {
    const Worker = installWorker();

    // Without Trusted Types the URL is a plain string, and no policy is made.
    assert.equal(workerScriptUrl(undefined), httpHeadersWorkerUrl, "no trusted types");

    const trustedTypes = installTrustedTypes();

    // Enforced, a plain string is refused, which is what the policy is for.
    assert.throws(() => new Worker(httpHeadersWorkerUrl), TypeError, "a plain string is refused");

    const worker = createHttpHeadersWorker() as unknown as InstanceType<typeof Worker>;
    assert.equal(worker.scriptUrl, httpHeadersWorkerUrl, "the worker is started at its URL");
    assert.deepEqual(trustedTypes.policyNames, [httpHeadersWorkerPolicyName], "the policy is the one the backend allows");

    // A second worker, as a page visited again makes, reuses the policy rather than being refused another.
    createHttpHeadersWorker();
    assert.equal(Worker.started.length, 2, "a second worker starts");
    assert.deepEqual(trustedTypes.policyNames, [httpHeadersWorkerPolicyName], "one policy");
});

test("the policy refuses any other URL", () => {
    let rules: {createScriptURL(url: string): string} | undefined;
    const recordingTrustedTypes = {
        createPolicy(_name: string, policyRules: {createScriptURL(url: string): string}) {
            rules = policyRules;
            return {createScriptURL: (url: string) => policyRules.createScriptURL(url)};
        },
    };

    // The policy was made by the previous test, so its rules are reached through a fresh module.
    return import(`../src/scripts/lib/http_headers_worker.ts?fresh=${Date.now()}`).then(module => {
        assert.equal(module.workerScriptUrl(recordingTrustedTypes), httpHeadersWorkerUrl, "its own URL");
        assert.ok(rules !== undefined, "a policy was made");
        assert.throws(() => rules!.createScriptURL("/evil.js"), TypeError, "another URL");
        assert.throws(() => rules!.createScriptURL(`${httpHeadersWorkerUrl}?x`), TypeError, "its URL with a query");
    });
});
