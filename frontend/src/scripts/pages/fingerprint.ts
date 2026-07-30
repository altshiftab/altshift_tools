import {customElement, query, state} from "lit/decorators.js";
import {css, html, LitElement, nothing} from "lit";

import {load as loadFingerprintJs} from "@fingerprintjs/fingerprintjs";
import {getFingerprint, getFingerprintData} from "@thumbmarkjs/thumbmarkjs";

import "@altshiftab/web_components/button";

const historyStorageKey = "fp-full-history";

type SignalMap = Record<string, string>;

interface ProbeHistory {
    loads: number;
    agg: Record<string, string[]>;
    comp: Record<string, string[]>;
}

interface AggregateResult {
    id: string;
    signalCount: string;
    distinct: number;
}

interface SurfaceResult {
    hash: string;
    distinct: number;
}

interface ProbeResult {
    fp: AggregateResult;
    tm: AggregateResult;
    sdk: AggregateResult;
    creep: AggregateResult;
    canvas: SurfaceResult;
    webgl: SurfaceResult;
    audio: SurfaceResult;
    lies: string[];
    trust: number;
    loads: number;
    changed: [string, string[]][];
    stable: [string, string][];
    all: [string, string][];
    snapshot: string;
}

type DiffResult =
    | {kind: "error"; message: string}
    | {kind: "identical"; total: number}
    | {kind: "rows"; rows: {key: string; previous: string; current: string}[]};

function cyrb53(str: string, seed = 0): string {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function canvasRaw(): string {
    const canvasElement = document.createElement("canvas");
    canvasElement.width = 280;
    canvasElement.height = 60;

    const context = canvasElement.getContext("2d");
    if (!context)
        return "no-canvas";

    context.textBaseline = "top";
    context.font = "16px 'Arial'";
    context.fillStyle = "#f60";
    context.fillRect(10, 10, 120, 30);
    context.fillStyle = "#069";
    context.fillText("Fingerprint \u{1F512} test", 12, 18);
    context.fillStyle = "rgba(102,204,0,0.7)";
    context.fillText("Fingerprint \u{1F512} test", 14, 20);

    return canvasElement.toDataURL();
}

interface WebglResult {
    raw: string;
    vendor: string;
    renderer: string;
    unmaskedVendor: string;
    unmaskedRenderer: string;
}

function webglRaw(): WebglResult {
    const canvasElement = document.createElement("canvas");
    canvasElement.width = 256;
    canvasElement.height = 128;

    const gl = (
        canvasElement.getContext("webgl", {preserveDrawingBuffer: true})
        ?? canvasElement.getContext("experimental-webgl", {preserveDrawingBuffer: true})
    ) as WebGLRenderingContext | null;
    if (!gl)
        return {raw: "no-webgl", vendor: "", renderer: "", unmaskedVendor: "", unmaskedRenderer: ""};

    const vendor = String(gl.getParameter(gl.VENDOR));
    const renderer = String(gl.getParameter(gl.RENDERER));

    // The generic VENDOR/RENDERER above are masked ("Mozilla" / "Mozilla"); the real GPU is
    // exposed via WEBGL_debug_renderer_info, which is exactly what the commercial SDKs read
    // (and what privacy.resistFingerprinting blocks — null here is itself a signal).
    let unmaskedVendor = "";
    let unmaskedRenderer = "";
    const debugRendererInfo = gl.getExtension("WEBGL_debug_renderer_info");
    if (debugRendererInfo) {
        unmaskedVendor = String(gl.getParameter(debugRendererInfo.UNMASKED_VENDOR_WEBGL));
        unmaskedRenderer = String(gl.getParameter(debugRendererInfo.UNMASKED_RENDERER_WEBGL));
    }

    const vertexShaderSource = "attribute vec2 p;varying vec2 v;void main(){v=p;gl_Position=vec4(p,0.,1.);}";
    const fragmentShaderSource = "precision mediump float;varying vec2 v;void main(){gl_FragColor=vec4(v*0.5+0.5,0.4,1.);}";

    function makeShader(type: number, source: string): WebGLShader {
        const shader = gl!.createShader(type)!;
        gl!.shaderSource(shader, source);
        gl!.compileShader(shader);
        return shader;
    }

    const program = gl.createProgram()!;
    gl.attachShader(program, makeShader(gl.VERTEX_SHADER, vertexShaderSource));
    gl.attachShader(program, makeShader(gl.FRAGMENT_SHADER, fragmentShaderSource));
    gl.linkProgram(program);
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.7, -0.7, 0.7, -0.7, 0., 0.8]), gl.STATIC_DRAW);

    const positionLocation = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    gl.clearColor(0.1, 0.2, 0.3, 1.);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const pixels = new Uint8Array(256 * 128 * 4);
    gl.readPixels(0, 0, 256, 128, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    let sampled = "";
    for (let i = 0; i < pixels.length; i += 997)
        sampled += pixels[i] + ",";

    const extensions = (gl.getSupportedExtensions() ?? []).join(",");

    return {raw: `${vendor}|${renderer}|${sampled}|${extensions}`, vendor, renderer, unmaskedVendor, unmaskedRenderer};
}

async function audioRaw(): Promise<string> {
    try {
        const OfflineAudioContextConstructor = window.OfflineAudioContext
            ?? (window as unknown as {webkitOfflineAudioContext?: typeof OfflineAudioContext}).webkitOfflineAudioContext;
        if (!OfflineAudioContextConstructor)
            return "no-offline-audio-context";

        const context = new OfflineAudioContextConstructor(1, 44100, 44100);

        const oscillator = context.createOscillator();
        oscillator.type = "triangle";
        oscillator.frequency.value = 10000;

        const compressor = context.createDynamicsCompressor();
        compressor.threshold.value = -50;
        compressor.knee.value = 40;
        compressor.ratio.value = 12;
        compressor.attack.value = 0;
        compressor.release.value = 0.25;

        oscillator.connect(compressor);
        compressor.connect(context.destination);
        oscillator.start(0);

        const renderedBuffer = await context.startRendering();
        const samples = renderedBuffer.getChannelData(0).subarray(4500, 5000);

        let sum = 0;
        for (let i = 0; i < samples.length; i++)
            sum += Math.abs(samples[i]);

        return sum.toString();
    } catch (error) {
        return "err:" + errorMessage(error);
    }
}

// The probes below replicate the collection surface of the commercial anti-fraud /
// bot-management SDKs seen in the wild (Akamai Bot Manager, DataDome, PerimeterX/HUMAN,
// iovation, Forter, Kount). Those SDKs are proprietary and domain-licensed, so rather than
// embedding them we reproduce the specific vectors they read that FingerprintJS / Thumbmark
// do not surface on their own.

async function uaClientHintsRaw(): Promise<string> {
    const uaData = (navigator as Navigator & {
        userAgentData?: {getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>>};
    }).userAgentData;
    if (!uaData)
        return "no-ua-ch";

    try {
        const highEntropy = await uaData.getHighEntropyValues([
            "architecture", "bitness", "model", "platform", "platformVersion",
            "uaFullVersion", "fullVersionList", "wow64",
        ]);
        return JSON.stringify(highEntropy);
    } catch (error) {
        return "err:" + errorMessage(error);
    }
}

function speechVoicesRaw(): Promise<string> {
    if (!("speechSynthesis" in window))
        return Promise.resolve("no-speech-synthesis");

    const synth = window.speechSynthesis;
    const format = (): string | null => {
        const voices = synth.getVoices();
        if (voices.length === 0)
            return null;
        return voices.map(voice => `${voice.name}|${voice.lang}${voice.default ? "|d" : ""}`).join(",");
    };

    return new Promise(resolve => {
        const immediate = format();
        if (immediate !== null) {
            resolve(immediate);
            return;
        }
        synth.addEventListener("voiceschanged", () => {
            const value = format();
            if (value !== null)
                resolve(value);
        }, {once: true});
        setTimeout(() => resolve(format() ?? "empty"), 1000);
    });
}

async function webrtcRaw(): Promise<string> {
    const PeerConnection = window.RTCPeerConnection
        ?? (window as unknown as {webkitRTCPeerConnection?: typeof RTCPeerConnection}).webkitRTCPeerConnection;
    if (!PeerConnection)
        return "no-webrtc";

    return new Promise(resolve => {
        let connection: RTCPeerConnection;
        try {
            connection = new PeerConnection({iceServers: []});
        } catch (error) {
            resolve("err:" + errorMessage(error));
            return;
        }

        const kinds = new Set<string>();
        let settled = false;
        const finish = () => {
            if (settled)
                return;
            settled = true;
            try {
                connection.close();
            } catch {
            }
            resolve(kinds.size ? [...kinds].sort().join(",") : "no-candidates");
        };

        connection.addEventListener("icecandidate", event => {
            const candidate = event.candidate?.candidate;
            if (!candidate) {
                finish();
                return;
            }
            // Record the candidate shape, not the address: a routable IPv4 vs an mDNS ".local"
            // placeholder is the discriminating signal (Firefox obfuscates the host by default).
            const type = / typ (\w+)/.exec(candidate)?.[1] ?? "?";
            const address = candidate.split(" ")[4] ?? "";
            const shape = /\.local$/.test(address)
                ? "mdns"
                : (/^\d+\.\d+\.\d+\.\d+$/.test(address) ? "ipv4" : "other");
            kinds.add(`${type}:${shape}`);
        });

        try {
            connection.createDataChannel("fp");
            connection.createOffer()
                .then(offer => connection.setLocalDescription(offer))
                .catch(() => finish());
        } catch (error) {
            resolve("err:" + errorMessage(error));
            return;
        }

        setTimeout(finish, 1500);
    });
}

async function mediaDevicesRaw(): Promise<string> {
    if (!navigator.mediaDevices?.enumerateDevices)
        return "no-media-devices";
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const counts: Record<string, number> = {};
        for (const device of devices)
            counts[device.kind] = (counts[device.kind] ?? 0) + 1;
        return Object.keys(counts).sort().map(kind => `${kind}:${counts[kind]}`).join(",");
    } catch (error) {
        return "err:" + errorMessage(error);
    }
}

async function permissionsRaw(): Promise<string> {
    if (!navigator.permissions?.query)
        return "no-permissions";

    const names = [
        "geolocation", "notifications", "camera", "microphone", "persistent-storage",
        "push", "midi", "clipboard-read", "clipboard-write", "accelerometer", "gyroscope",
    ];

    const states: string[] = [];
    for (const name of names) {
        try {
            const status = await navigator.permissions.query({name: name as PermissionName});
            states.push(`${name}:${status.state}`);
        } catch {
            // A thrown query means the permission name is unsupported — itself a discriminator.
            states.push(`${name}:unsupported`);
        }
    }
    return states.join(",");
}

async function batteryRaw(): Promise<string> {
    const getBattery = (navigator as Navigator & {
        getBattery?: () => Promise<{level: number; charging: boolean}>;
    }).getBattery;
    if (!getBattery)
        return "no-battery";
    try {
        const battery = await getBattery.call(navigator);
        return `level=${battery.level} charging=${battery.charging}`;
    } catch (error) {
        return "err:" + errorMessage(error);
    }
}

async function storageQuotaRaw(): Promise<string> {
    if (!navigator.storage?.estimate)
        return "no-storage-estimate";
    try {
        const estimate = await navigator.storage.estimate();
        const quotaGiB = Math.round(((estimate.quota ?? 0) / (1024 ** 3)) * 10) / 10;
        return `quotaGiB≈${quotaGiB}`;
    } catch (error) {
        return "err:" + errorMessage(error);
    }
}

function networkInfoRaw(): string {
    const connection = (navigator as Navigator & {
        connection?: {effectiveType?: string; type?: string; saveData?: boolean};
    }).connection;
    if (!connection)
        return "no-connection";
    // downlink / rtt fluctuate every load, so only the stable descriptors feed the fingerprint.
    return `effectiveType=${connection.effectiveType ?? "?"} type=${connection.type ?? "?"} saveData=${connection.saveData ?? false}`;
}

function localePreferencesRaw(): string {
    const parts: string[] = [];
    try {
        const dateTime = Intl.DateTimeFormat().resolvedOptions() as Intl.ResolvedDateTimeFormatOptions & {hourCycle?: string};
        parts.push(`locale=${dateTime.locale}`, `calendar=${dateTime.calendar}`, `numbering=${dateTime.numberingSystem}`, `hourCycle=${dateTime.hourCycle ?? "?"}`);
    } catch {
    }
    try {
        const locale = new Intl.Locale(navigator.language) as Intl.Locale & {
            getWeekInfo?: () => {firstDay?: number};
            weekInfo?: {firstDay?: number};
        };
        const weekInfo = locale.getWeekInfo?.() ?? locale.weekInfo;
        if (weekInfo?.firstDay !== undefined)
            parts.push(`firstDay=${weekInfo.firstDay}`);
    } catch {
    }
    return parts.join(" ");
}

function screenGeometryRaw(): string {
    const s = screen as Screen & {availLeft?: number; availTop?: number};
    const orientation = s.orientation?.type ?? "?";
    // outer-minus-inner exposes browser chrome (toolbar) height; avail* exposes the OS taskbar/dock.
    const chromeHeight = Math.max(0, outerHeight - innerHeight);
    const chromeWidth = Math.max(0, outerWidth - innerWidth);
    return `orientation=${orientation} avail=${s.availWidth}x${s.availHeight} availOffset=${s.availLeft ?? 0},${s.availTop ?? 0} chrome=${chromeWidth}x${chromeHeight} depth=${s.colorDepth}/${s.pixelDepth}`;
}

function privacyFlagsRaw(): string {
    const n = navigator as Navigator & {
        globalPrivacyControl?: boolean;
        oscpu?: string;
        pdfViewerEnabled?: boolean;
        webdriver?: boolean;
    };
    return [
        `gpc=${n.globalPrivacyControl ?? "unset"}`,
        `dnt=${n.doNotTrack ?? "unset"}`,
        `cookies=${n.cookieEnabled}`,
        `pdfViewer=${n.pdfViewerEnabled ?? "?"}`,
        `oscpu=${n.oscpu ?? "?"}`,
        `productSub=${n.productSub}`,
        `webdriver=${n.webdriver ?? false}`,
    ].join(" ");
}

// ---- CreepJS-style trust / lie detection ----
// A scoped re-implementation of CreepJS's method (worker-vs-main mismatch, native-function
// integrity, automation / consistency tells) rather than a vendored copy of the upstream
// research app, per this repo's minimal-dependency convention.

interface WorkerFingerprint {
    userAgent: string;
    hardwareConcurrency: number;
    platform: string;
    languages: string;
    timezone: string;
    canvas: string;
}

function workerFingerprintRaw(): Promise<WorkerFingerprint | string> {
    if (!("Worker" in window))
        return Promise.resolve("no-worker");

    // Computed in a separate JS realm; spoofing extensions that only patch the main thread
    // (and Firefox RFP) leave the worker's values inconsistent with the page's.
    const workerSource = `
        self.onmessage = async () => {
            const n = self.navigator;
            const result = {
                userAgent: n.userAgent,
                hardwareConcurrency: n.hardwareConcurrency,
                platform: n.platform || "",
                languages: (n.languages || []).join(","),
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
                canvas: "unavailable",
            };
            try {
                const canvas = new OffscreenCanvas(200, 40);
                const context = canvas.getContext("2d");
                context.textBaseline = "top";
                context.font = "14px 'Arial'";
                context.fillStyle = "#069";
                context.fillText("worker \\u{1F512}", 2, 2);
                const bytes = new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer());
                let hash = 0;
                for (let i = 0; i < bytes.length; i++)
                    hash = (hash * 31 + bytes[i]) >>> 0;
                result.canvas = hash.toString(16);
            } catch (error) {
                result.canvas = "err";
            }
            self.postMessage(result);
        };
    `;

    return new Promise(resolve => {
        let worker: Worker;
        let url: string;
        try {
            url = URL.createObjectURL(new Blob([workerSource], {type: "text/javascript"}));
            worker = new Worker(url);
        } catch (error) {
            resolve("blocked:" + errorMessage(error));
            return;
        }

        const cleanup = () => {
            try {
                worker.terminate();
            } catch {
            }
            try {
                URL.revokeObjectURL(url);
            } catch {
            }
        };

        worker.addEventListener("message", event => {
            cleanup();
            resolve(event.data as WorkerFingerprint);
        });
        worker.addEventListener("error", event => {
            cleanup();
            resolve("worker-error:" + (event.message || "unknown"));
        });
        worker.postMessage(null);
        setTimeout(() => {
            cleanup();
            resolve("timeout");
        }, 2000);
    });
}

interface CreepResult {
    lies: string[];
    trust: number;
    signals: SignalMap;
}

async function creepProbe(): Promise<CreepResult> {
    const lies: string[] = [];
    const signals: SignalMap = {};
    const n = navigator as Navigator & {webdriver?: boolean};

    signals["automation.webdriver"] = String(n.webdriver ?? false);
    if (n.webdriver)
        lies.push("navigator.webdriver=true");

    const hasWindowChrome = "chrome" in window;
    signals["automation.windowChrome"] = String(hasWindowChrome);
    if (/ Chrome\//.test(n.userAgent) && !hasWindowChrome)
        lies.push("UA claims Chrome but window.chrome is absent");

    const platform = n.platform ?? "";
    signals["consistency.platform"] = platform;
    if (platform !== "" && /Windows/.test(n.userAgent) !== /Win/.test(platform))
        lies.push(`UA/platform mismatch (platform=${platform})`);

    try {
        const permissionState = (await navigator.permissions.query({name: "notifications" as PermissionName})).state;
        const apiState = typeof Notification !== "undefined" ? Notification.permission : "n/a";
        signals["consistency.notifications"] = `perm=${permissionState} api=${apiState}`;
        if (permissionState === "denied" && apiState === "default")
            lies.push("notifications: Permissions=denied but Notification=default (headless tell)");
    } catch {
    }

    const nativeChecks: [string, () => unknown][] = [
        ["canvas.toDataURL", () => HTMLCanvasElement.prototype.toDataURL],
        ["webgl.getParameter", () => WebGLRenderingContext.prototype.getParameter],
        ["permissions.query", () => Permissions.prototype.query],
    ];
    const tampered: string[] = [];
    for (const [name, getter] of nativeChecks) {
        try {
            const value = getter();
            if (typeof value === "function" && !/\{\s*\[native code]\s*}/.test(Function.prototype.toString.call(value)))
                tampered.push(name);
        } catch {
            tampered.push(`${name}:throws`);
        }
    }
    signals["integrity.nativeFunctions"] = tampered.length ? `tampered:${tampered.join(",")}` : "all-native";
    if (tampered.length)
        lies.push(`non-native functions: ${tampered.join(",")}`);

    const workerFingerprint = await workerFingerprintRaw();
    if (typeof workerFingerprint === "string") {
        signals["worker.status"] = workerFingerprint;
    } else {
        const mainTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        signals["worker.userAgent"] = workerFingerprint.userAgent === n.userAgent
            ? "match"
            : `MISMATCH (${token(workerFingerprint.userAgent)})`;
        signals["worker.hardwareConcurrency"] = String(workerFingerprint.hardwareConcurrency) === String(n.hardwareConcurrency)
            ? "match"
            : `MISMATCH (${workerFingerprint.hardwareConcurrency} vs ${n.hardwareConcurrency})`;
        signals["worker.timezone"] = workerFingerprint.timezone === mainTimezone
            ? "match"
            : `MISMATCH (${workerFingerprint.timezone} vs ${mainTimezone})`;
        signals["worker.canvasHash"] = workerFingerprint.canvas;

        if (workerFingerprint.userAgent && workerFingerprint.userAgent !== n.userAgent)
            lies.push("worker userAgent ≠ main");
        if (String(workerFingerprint.hardwareConcurrency) !== String(n.hardwareConcurrency))
            lies.push("worker hardwareConcurrency ≠ main");
        if (workerFingerprint.timezone && workerFingerprint.timezone !== mainTimezone)
            lies.push("worker timezone ≠ main");
    }

    const trust = Math.max(0, 100 - lies.length * 20);
    signals["trust.score"] = String(trust);
    signals["trust.lies"] = lies.length ? lies.join(" | ") : "none";

    return {lies, trust, signals};
}

function identity(webgl: WebglResult): SignalMap {
    const n = navigator;
    const s = screen;
    return {
        userAgent: n.userAgent,
        platform: n.platform,
        languages: (n.languages ?? []).join(",") + " (language=" + n.language + ")",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone + " (offset " + new Date().getTimezoneOffset() + ")",
        screen: `${s.width}x${s.height} avail ${s.availWidth}x${s.availHeight} depth ${s.colorDepth}`,
        windowInner: `${innerWidth}x${innerHeight} dpr ${devicePixelRatio}`,
        hardwareConcurrency: String(n.hardwareConcurrency),
        deviceMemory: String((n as unknown as {deviceMemory?: number}).deviceMemory),
        maxTouchPoints: String(n.maxTouchPoints),
        webglVendorRenderer: webgl.vendor || webgl.renderer ? `${webgl.vendor} / ${webgl.renderer}` : "?",
        webglUnmasked: webgl.unmaskedVendor || webgl.unmaskedRenderer
            ? `${webgl.unmaskedVendor} / ${webgl.unmaskedRenderer}`
            : "(masked/blocked)",
    };
}

function token(value: unknown): string {
    const stringValue = String(value);
    return stringValue.length > 256 ? `#${cyrb53(stringValue)} (len ${stringValue.length})` : stringValue;
}

function flatten(value: unknown, prefix: string, out: SignalMap): SignalMap {
    if (value === null || value === undefined) {
        out[prefix] = `(${String(value)})`;
        return out;
    }

    const valueType = typeof value;
    if (valueType === "string" || valueType === "number" || valueType === "boolean") {
        out[prefix] = token(value);
        return out;
    }

    if (Array.isArray(value)) {
        if (value.every(element => element === null || ["string", "number", "boolean"].includes(typeof element)))
            out[prefix] = token(value.join("|"));
        else
            value.forEach((element, index) => flatten(element, `${prefix}[${index}]`, out));
        return out;
    }

    if (valueType === "object") {
        const objectValue = value as Record<string, unknown>;
        if ("value" in objectValue && "duration" in objectValue)
            return flatten(objectValue.value, prefix, out);

        const keys = Object.keys(objectValue);
        if (keys.length === 0) {
            out[prefix] = "{}";
            return out;
        }

        for (const key of keys)
            flatten(objectValue[key], `${prefix}.${key}`, out);
        return out;
    }

    out[prefix] = token(String(value));
    return out;
}

function loadHistory(): ProbeHistory {
    let history: unknown;
    try {
        history = JSON.parse(localStorage.getItem(historyStorageKey) ?? "");
    } catch {
    }

    const historyObject = (history && typeof history === "object" ? history : {}) as Partial<ProbeHistory>;
    return {
        loads: historyObject.loads ?? 0,
        agg: historyObject.agg ?? {},
        comp: historyObject.comp ?? {},
    };
}

function saveHistory(history: ProbeHistory): void {
    try {
        localStorage.setItem(historyStorageKey, JSON.stringify(history));
    } catch {
    }
}

function addDistinct(values: string[], value: string): number {
    if (value != null && !values.includes(value))
        values.push(value);
    return values.length;
}

function distinctTag(count: number): string {
    return count === 1 ? "1 — stable" : `${count} — CHANGING`;
}

@customElement("fingerprint-content")
export default class FingerprintContent extends LitElement {
    @state()
    private _result: ProbeResult | null = null;

    @state()
    private _diff: DiffResult | null = null;

    @query(".snapshot-input")
    private _snapshotInputTextarea!: HTMLTextAreaElement;

    private _currentMap: SignalMap = {};

    static styles = css`
        :host {
            --main-color: var(--altshift-main-color);
            --text-color: var(--altshift-text-color);
            --border-width: var(--altshift-border-width);
            --border-color: var(--altshift-border-color);
            --highlight-color: var(--altshift-orange);

            display: flex;
            flex-direction: column;
            gap: 1rem;

            h1 {
                margin: 0;
            }

            h2 {
                margin: 1rem 0 0;
            }

            table {
                border-collapse: collapse;
                width: 100%;
            }

            td, th {
                border: var(--border-width) solid var(--border-color);
                padding: 0.35rem 0.5rem;
                text-align: left;
                vertical-align: top;
                word-break: break-all;
            }

            td {
                font-family: monospace;
            }

            .hash {
                font-weight: bold;
            }

            .changed {
                color: var(--highlight-color);
                font-weight: bold;
            }

            .key {
                white-space: nowrap;
            }

            details > summary {
                cursor: pointer;
            }

            altshift-button {
                width: fit-content;
                --altshift-text-box-font-size: 1rem;
                --altshift-text-box-padding: 0.375rem 1rem;
            }

            textarea {
                width: 100%;
                box-sizing: border-box;
                height: 6rem;
                resize: vertical;
                background-color: var(--main-color);
                color: var(--text-color);
                padding: 0.5rem 1rem;
                border: var(--border-width) solid var(--border-color);
                font-family: monospace;

                &:focus-visible {
                    outline: var(--text-color) solid calc(0.5 * var(--border-width));
                }
            }

        }
    `;

    firstUpdated() {
        this._probe().catch((error: unknown) => {
            throw new Error(`The fingerprint probe failed: ${errorMessage(error)}`);
        });
    }

    private async _probe(): Promise<void> {
        const currentMap: SignalMap = {};

        const canvasString = canvasRaw();
        const canvasHash = cyrb53(canvasString);

        const webgl = webglRaw();
        const webglHash = cyrb53(webgl.raw);

        const audioString = await audioRaw();
        const audioHash = cyrb53(audioString);

        let fpId = "(lib failed)";
        let fpSignalCount = "?";
        try {
            const agent = await loadFingerprintJs();
            const result = await agent.get();
            fpId = result.visitorId;

            const components = result.components as Record<string, {value?: unknown; error?: unknown}>;
            fpSignalCount = String(Object.keys(components).length);
            for (const [key, component] of Object.entries(components)) {
                if (component && "value" in component)
                    flatten(component.value, `fp.${key}`, currentMap);
                else if (component && component.error) {
                    const componentError = component.error as {message?: unknown};
                    currentMap[`fp.${key}.error`] = token(String(componentError.message ?? component.error));
                }
            }
        } catch (error) {
            fpId = "err:" + errorMessage(error);
        }

        let tmId = "(lib failed)";
        let tmSignalCount = "?";
        try {
            tmId = await getFingerprint();

            const thumbmarkMap: SignalMap = {};
            flatten(await getFingerprintData(), "tm", thumbmarkMap);
            Object.assign(currentMap, thumbmarkMap);
            tmSignalCount = String(Object.keys(thumbmarkMap).length);
        } catch (error) {
            tmId = "err:" + errorMessage(error);
        }

        currentMap["surface.canvas"] = `#${canvasHash} (dataURL len ${canvasString.length})`;
        currentMap["surface.webgl"] = `#${webglHash} | ${webgl.vendor} / ${webgl.renderer}`;
        currentMap["surface.audio"] = audioString;

        for (const [key, value] of Object.entries(identity(webgl)))
            currentMap[`id.${key}`] = token(value);

        const [uaClientHints, speechVoices, webrtc, mediaDevices, permissionStates, battery, storageQuota] =
            await Promise.all([
                uaClientHintsRaw(),
                speechVoicesRaw(),
                webrtcRaw(),
                mediaDevicesRaw(),
                permissionsRaw(),
                batteryRaw(),
                storageQuotaRaw(),
            ]);
        const creep = await creepProbe();

        const sdkSignals: SignalMap = {
            webglUnmasked: webgl.unmaskedVendor || webgl.unmaskedRenderer
                ? `${webgl.unmaskedVendor} / ${webgl.unmaskedRenderer}`
                : "(masked/blocked)",
            uaClientHints: token(uaClientHints),
            speechVoices: token(speechVoices),
            webrtc,
            mediaDevices,
            permissions: token(permissionStates),
            battery,
            storageQuota,
            network: networkInfoRaw(),
            locale: localePreferencesRaw(),
            screenGeometry: screenGeometryRaw(),
            privacyFlags: privacyFlagsRaw(),
            canvas: `#${canvasHash}`,
            audio: `#${audioHash}`,
        };
        for (const [key, value] of Object.entries(sdkSignals))
            currentMap[`sdk.${key}`] = value;
        for (const [key, value] of Object.entries(creep.signals))
            currentMap[`creep.${key}`] = value;

        const canonical = (map: SignalMap): string =>
            Object.keys(map).sort().map(key => `${key}=${map[key]}`).join("~");
        const sdkId = cyrb53(canonical(sdkSignals));
        const sdkSignalCount = String(Object.keys(sdkSignals).length);
        const creepId = cyrb53(canonical(creep.signals));
        const creepSignalCount = String(Object.keys(creep.signals).length);

        const history = loadHistory();
        history.loads++;

        for (const aggregateKey of ["fp", "tm", "sdk", "creep", "canvas", "webgl", "audio"])
            history.agg[aggregateKey] = history.agg[aggregateKey] ?? [];

        const fpDistinct = addDistinct(history.agg.fp, fpId);
        const tmDistinct = addDistinct(history.agg.tm, tmId);
        const sdkDistinct = addDistinct(history.agg.sdk, sdkId);
        const creepDistinct = addDistinct(history.agg.creep, creepId);
        const canvasDistinct = addDistinct(history.agg.canvas, canvasHash);
        const webglDistinct = addDistinct(history.agg.webgl, webglHash);
        const audioDistinct = addDistinct(history.agg.audio, audioHash);

        for (const [key, value] of Object.entries(currentMap)) {
            history.comp[key] = history.comp[key] ?? [];
            if (!history.comp[key].includes(value))
                history.comp[key].push(value);
        }

        saveHistory(history);

        const changed: [string, string[]][] = Object.keys(history.comp)
            .filter(key => history.comp[key].length > 1)
            .sort()
            .map(key => [key, history.comp[key]]);

        const stable: [string, string][] = Object.keys(currentMap)
            .filter(key => !(history.comp[key] && history.comp[key].length > 1))
            .sort()
            .map(key => [key, currentMap[key]]);

        const all: [string, string][] = Object.keys(currentMap).sort().map(key => [key, currentMap[key]]);

        this._currentMap = currentMap;
        this._result = {
            fp: {id: fpId, signalCount: fpSignalCount, distinct: fpDistinct},
            tm: {id: tmId, signalCount: tmSignalCount, distinct: tmDistinct},
            sdk: {id: sdkId, signalCount: sdkSignalCount, distinct: sdkDistinct},
            creep: {id: creepId, signalCount: creepSignalCount, distinct: creepDistinct},
            canvas: {hash: canvasHash, distinct: canvasDistinct},
            webgl: {hash: webglHash, distinct: webglDistinct},
            audio: {hash: audioHash, distinct: audioDistinct},
            lies: creep.lies,
            trust: creep.trust,
            loads: history.loads,
            changed,
            stable,
            all,
            snapshot: JSON.stringify(currentMap, Object.keys(currentMap).sort(), 0),
        };
    }

    private _reset = () => {
        localStorage.removeItem(historyStorageKey);
        location.reload();
    };

    private _copySnapshot = async () => {
        const snapshot = this._result?.snapshot;
        if (!snapshot)
            return;

        try {
            await navigator.clipboard.writeText(snapshot);
        } catch {
        }
    };

    private _diffSnapshots = () => {
        let previous: unknown;
        try {
            previous = JSON.parse(this._snapshotInputTextarea.value);
        } catch {
            this._diff = {kind: "error", message: "✗ pasted text is not valid snapshot JSON"};
            return;
        }

        if (!previous || typeof previous !== "object") {
            this._diff = {kind: "error", message: "✗ pasted text is not valid snapshot JSON"};
            return;
        }

        const previousMap = previous as SignalMap;
        const currentMap = this._currentMap;

        const keys = new Set([...Object.keys(previousMap), ...Object.keys(currentMap)]);
        const changedKeys = [...keys].sort().filter(key => previousMap[key] !== currentMap[key]);

        if (changedKeys.length === 0) {
            this._diff = {kind: "identical", total: Object.keys(currentMap).length};
            return;
        }

        this._diff = {
            kind: "rows",
            rows: changedKeys.map(key => ({
                key,
                previous: key in previousMap ? previousMap[key] : "(absent)",
                current: key in currentMap ? currentMap[key] : "(absent)",
            })),
        };
    };

    private _renderContributingParameters(libraryName: string, prefix: string) {
        const result = this._result;
        if (!result)
            return nothing;

        const parameters = result.all.filter(([key]) => key.startsWith(prefix));
        return html`
            <details>
                <summary>${libraryName} parameters (${parameters.length})</summary>
                <table>
                    <tr><th>Parameter</th><th>Value (this load)</th></tr>
                    ${parameters.map(([key, value]) => html`
                        <tr>
                            <td class="key">${key.slice(prefix.length)}</td>
                            <td>${value}</td>
                        </tr>
                    `)}
                </table>
            </details>
        `;
    }

    private _renderDiff() {
        const diff = this._diff;
        if (!diff)
            return nothing;

        switch (diff.kind) {
            case "error":
                return html`<table><tr><td colspan="3" class="changed">${diff.message}</td></tr></table>`;
            case "identical":
                return html`
                    <table>
                        <tr><th>Signal</th><th>Previous snapshot</th><th>This load</th></tr>
                        <tr><td colspan="3" class="stable">✓ identical — all ${diff.total} signals match; fingerprint is STABLE across these two snapshots</td></tr>
                    </table>
                `;
            case "rows":
                return html`
                    <table>
                        <tr><th>Signal</th><th>Previous snapshot</th><th>This load</th></tr>
                        ${diff.rows.map(row => html`
                            <tr>
                                <td class="key">${row.key}</td>
                                <td>${row.previous}</td>
                                <td class="changed">${row.current}</td>
                            </tr>
                        `)}
                        <tr><td colspan="3" class="changed">${diff.rows.length} signal(s) changed between the two sessions</td></tr>
                    </table>
                `;
        }
    }

    render() {
        const result = this._result;

        return html`
            <h1>Aggregated fingerprint probe</h1>

            <h2>Aggregated fingerprint value</h2>
            <table>
                <tr><th>Source</th><th>Fingerprint (this load)</th><th>Signals</th><th>Distinct seen this origin</th></tr>
                <tr>
                    <td>FingerprintJS</td>
                    <td class="hash">${result?.fp.id ?? "…"}</td>
                    <td>${result?.fp.signalCount ?? "…"}</td>
                    <td>${result ? distinctTag(result.fp.distinct) : "…"}</td>
                </tr>
                <tr>
                    <td>Thumbmark</td>
                    <td class="hash">${result?.tm.id ?? "…"}</td>
                    <td>${result?.tm.signalCount ?? "…"}</td>
                    <td>${result ? distinctTag(result.tm.distinct) : "…"}</td>
                </tr>
                <tr>
                    <td>Anti-fraud surface (hand-rolled)</td>
                    <td class="hash">${result?.sdk.id ?? "…"}</td>
                    <td>${result?.sdk.signalCount ?? "…"}</td>
                    <td>${result ? distinctTag(result.sdk.distinct) : "…"}</td>
                </tr>
                <tr>
                    <td>CreepJS-style</td>
                    <td class="hash">${result?.creep.id ?? "…"}</td>
                    <td>${result?.creep.signalCount ?? "…"}</td>
                    <td>${result ? distinctTag(result.creep.distinct) : "…"}</td>
                </tr>
            </table>
            ${this._renderContributingParameters("FingerprintJS", "fp.")}
            ${this._renderContributingParameters("Thumbmark", "tm.")}
            ${this._renderContributingParameters("Anti-fraud surface", "sdk.")}
            ${this._renderContributingParameters("CreepJS-style", "creep.")}

            <h2>Bot / lie detection (CreepJS-style)</h2>
            <table>
                <tr><th>Trust score</th><td>${result ? `${result.trust} / 100` : "…"}</td></tr>
                <tr>
                    <th>Lies${result ? ` (${result.lies.length})` : ""}</th>
                    <td class=${result && result.lies.length ? "changed" : "stable"}>
                        ${result ? (result.lies.length ? result.lies.join("; ") : "none detected") : "…"}
                    </td>
                </tr>
            </table>

            <h2>Per-surface hashes</h2>
            <table>
                <tr><th>Surface</th><th>Hash</th><th>Distinct seen this origin</th></tr>
                <tr>
                    <td>Canvas 2D</td>
                    <td class="hash">${result?.canvas.hash ?? "…"}</td>
                    <td>${result ? distinctTag(result.canvas.distinct) : "…"}</td>
                </tr>
                <tr>
                    <td>WebGL render</td>
                    <td class="hash">${result?.webgl.hash ?? "…"}</td>
                    <td>${result ? distinctTag(result.webgl.distinct) : "…"}</td>
                </tr>
                <tr>
                    <td>AudioContext</td>
                    <td class="hash">${result?.audio.hash ?? "…"}</td>
                    <td>${result ? distinctTag(result.audio.distinct) : "…"}</td>
                </tr>
            </table>
            <p>Loads recorded for this origin: ${result?.loads ?? "…"}</p>
            <altshift-button type="button" @click=${this._reset}>Reset</altshift-button>

            <h2>Signals that changed</h2>
            <table>
                <tr><th>Signal</th><th>Distinct values seen this session (exact)</th></tr>
                ${result && result.changed.length === 0 ? html`
                    <tr><td colspan="2" class="stable">none — every signal stable across ${result.loads} load(s) this session</td></tr>
                ` : nothing}
                ${result?.changed.map(([key, values]) => html`
                    <tr>
                        <td class="key">${key}</td>
                        <td class="changed">${values.join("   ⇄   ")}</td>
                    </tr>
                `)}
            </table>

            <h2>Signals that are stable</h2>
            ${result ? html`
                <p>${result.stable.length} of ${result.all.length} signals stable across ${result.loads} load(s)</p>
            ` : nothing}
            <details open>
                <summary>show stable signals and their exact values</summary>
                <table>
                    <tr><th>Signal</th><th>Stable value (exact)</th></tr>
                    ${result?.stable.map(([key, value]) => html`
                        <tr>
                            <td class="key">${key}</td>
                            <td class="stable">${value}</td>
                        </tr>
                    `)}
                </table>
            </details>

            <h2>Compare across sessions</h2>
            <altshift-button type="button" @click=${this._copySnapshot}>Copy</altshift-button>
            <textarea readonly placeholder="current snapshot appears here" .value=${result?.snapshot ?? ""}></textarea>
            <p>Paste a previous snapshot here:</p>
            <textarea class="snapshot-input" autocomplete="off" spellcheck="false" placeholder="paste a snapshot from another session"></textarea>
            <altshift-button type="button" @click=${this._diffSnapshots}>Compare</altshift-button>
            ${this._renderDiff()}

            <h2>All current signal values</h2>
            <details>
                <summary>show every captured signal and its exact value${result ? ` (${result.all.length})` : ""}</summary>
                <table>
                    <tr><th>Signal</th><th>Exact value (this load)</th></tr>
                    ${result?.all.map(([key, value]) => html`
                        <tr>
                            <td class="key">${key}</td>
                            <td>${value}</td>
                        </tr>
                    `)}
                </table>
            </details>
        `;
    }
}
