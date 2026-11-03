// The /http-headers analysis worker is served beside the Go runtime glue and the analysis module, at a
// fixed path the backend owns; see backend/http_headers_assets.go.
export const httpHeadersWorkerUrl = "/analysis/http_headers/worker.js";

// The Trusted Types policy that may name the worker's script; the backend allows it by this name.
export const httpHeadersWorkerPolicyName = "http-headers-worker";

interface TrustedTypePolicyLike {
    createScriptURL(url: string): unknown;
}

export interface TrustedTypesLike {
    createPolicy(name: string, rules: {createScriptURL(url: string): string}): TrustedTypePolicyLike;
}

let policy: TrustedTypePolicyLike | undefined;

// workerScriptUrl returns the worker URL in the form the page's policy accepts: a TrustedScriptURL
// where the browser enforces Trusted Types, the plain string where it does not. The policy vouches
// for this one URL and nothing else, and is made once, a second policy of the name being refused.
export function workerScriptUrl(
    trustedTypes: TrustedTypesLike | undefined = (globalThis as {trustedTypes?: TrustedTypesLike}).trustedTypes,
): string {
    if (trustedTypes === undefined) {
        return httpHeadersWorkerUrl;
    }

    policy ??= trustedTypes.createPolicy(httpHeadersWorkerPolicyName, {
        createScriptURL(url: string): string {
            if (url !== httpHeadersWorkerUrl) {
                throw new TypeError(`${httpHeadersWorkerPolicyName} does not vouch for ${url}`);
            }
            return url;
        },
    });

    // Worker accepts a TrustedScriptURL wherever it accepts a string.
    return policy.createScriptURL(httpHeadersWorkerUrl) as string;
}

// createHttpHeadersWorker starts the analysis worker. It is a classic worker, which is what lets it
// load the Go runtime glue with importScripts.
export function createHttpHeadersWorker(): Worker {
    return new Worker(workerScriptUrl());
}
