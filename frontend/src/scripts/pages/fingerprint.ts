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
    canvas: SurfaceResult;
    webgl: SurfaceResult;
    audio: SurfaceResult;
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
        return {raw: "no-webgl", vendor: "", renderer: ""};

    const vendor = String(gl.getParameter(gl.VENDOR));
    const renderer = String(gl.getParameter(gl.RENDERER));

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

    return {raw: `${vendor}|${renderer}|${sampled}|${extensions}`, vendor, renderer};
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

        const history = loadHistory();
        history.loads++;

        for (const aggregateKey of ["fp", "tm", "canvas", "webgl", "audio"])
            history.agg[aggregateKey] = history.agg[aggregateKey] ?? [];

        const fpDistinct = addDistinct(history.agg.fp, fpId);
        const tmDistinct = addDistinct(history.agg.tm, tmId);
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
            canvas: {hash: canvasHash, distinct: canvasDistinct},
            webgl: {hash: webglHash, distinct: webglDistinct},
            audio: {hash: audioHash, distinct: audioDistinct},
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
                <tr><th>Library</th><th>Fingerprint (this load)</th><th>Signals</th><th>Distinct seen this origin</th></tr>
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
            </table>
            ${this._renderContributingParameters("FingerprintJS", "fp.")}
            ${this._renderContributingParameters("Thumbmark", "tm.")}

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
            <altshift-button type="button" @click=${this._reset}>Reset session history</altshift-button>

            <h2>Signals that changed within this session</h2>
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

            <h2>Signals that are stable this session</h2>
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
            <altshift-button type="button" @click=${this._copySnapshot}>Copy snapshot (this load)</altshift-button>
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
