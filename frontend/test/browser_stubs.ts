// Hand-made stand-ins for the browser APIs the /http-headers modules reach for, installed on globalThis
// for a test and restored after it.

// FakeTrustedScriptUrl is what a policy hands back: not a string, so a sink that is given a string
// instead can tell, as an enforcing browser does.
export class FakeTrustedScriptUrl {
    readonly url: string;

    constructor(url: string) {
        this.url = url;
    }

    toString(): string {
        return this.url;
    }
}

// FakeTrustedTypes models what the page relies on: a policy's rules decide what it vouches for, and a
// second policy of a name is refused, as it is without 'allow-duplicates'.
export class FakeTrustedTypes {
    readonly policyNames: string[] = [];

    createPolicy(name: string, rules: {createScriptURL(url: string): string}) {
        if (this.policyNames.includes(name)) {
            throw new TypeError(`Policy with name "${name}" already exists.`);
        }
        this.policyNames.push(name);

        return {
            createScriptURL: (url: string) => new FakeTrustedScriptUrl(rules.createScriptURL(url)),
        };
    }
}

// FakeWorker records the script it was started with, and refuses a plain string where Trusted Types
// are enforced, as the Worker constructor does.
export class FakeWorker {
    static readonly started: FakeWorker[] = [];
    static enforceTrustedTypes = false;

    readonly scriptUrl: string;

    constructor(scriptUrl: unknown) {
        if (FakeWorker.enforceTrustedTypes && !(scriptUrl instanceof FakeTrustedScriptUrl)) {
            throw new TypeError("This document requires 'TrustedScriptURL' assignment.");
        }
        this.scriptUrl = String(scriptUrl);
        FakeWorker.started.push(this);
    }
}

const installed = new Map<string, PropertyDescriptor | undefined>();

function install(name: string, value: unknown): void {
    if (!installed.has(name)) {
        installed.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    }
    Object.defineProperty(globalThis, name, {value, configurable: true, writable: true});
}

// installTrustedTypes makes the page's realm enforce Trusted Types, as the site's policy does.
export function installTrustedTypes(): FakeTrustedTypes {
    const trustedTypes = new FakeTrustedTypes();
    install("trustedTypes", trustedTypes);
    FakeWorker.enforceTrustedTypes = true;
    return trustedTypes;
}

export function installWorker(): typeof FakeWorker {
    FakeWorker.started.length = 0;
    install("Worker", FakeWorker);
    return FakeWorker;
}

export function restoreBrowserStubs(): void {
    for (const [name, descriptor] of installed) {
        if (descriptor === undefined) {
            delete (globalThis as Record<string, unknown>)[name];
        } else {
            Object.defineProperty(globalThis, name, descriptor);
        }
    }
    installed.clear();
    FakeWorker.enforceTrustedTypes = false;
    FakeWorker.started.length = 0;
}
