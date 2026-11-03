import {customElement, query, state} from "lit/decorators.js";
import {css, html, LitElement, nothing} from "lit";
import {classMap} from "lit/directives/class-map.js";

import "@altshiftab/web_components/button";

import {HttpHeadersClient} from "../lib/http_headers_client.ts";
import {
    countLevels,
    findingDetails,
    findingLocation,
    type Finding,
    type FindingGroup,
    type Report,
} from "../lib/http_headers_report.ts";
import {HttpHeadersSession, type ViewState} from "../lib/http_headers_session.ts";
import {createHttpHeadersWorker} from "../lib/http_headers_worker.ts";

// A response with the faults a real one commonly has: a policy that lets inline script and a CDN run,
// no Strict-Transport-Security, a referrer policy that sends the whole URL, and a server that says
// what it runs. The cookie is there to be pasted with the rest, as it would be.
const exampleHeaders = [
    "HTTP/2 200",
    "content-type: text/html; charset=utf-8",
    "content-security-policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; object-src 'none'",
    "x-frame-options: SAMEORIGIN",
    "x-content-type-options: nosniff",
    "referrer-policy: unsafe-url",
    "server: nginx/1.25.3",
    "x-powered-by: Express",
    "set-cookie: session=0123456789abcdef; Path=/; HttpOnly",
    "",
].join("\n");

@customElement("http-headers-content")
export default class HttpHeadersContent extends LitElement {
    readonly #session = new HttpHeadersSession(
        () => HttpHeadersClient.start(createHttpHeadersWorker),
        state => void (this._view = state),
    );

    @query("textarea")
    private _textarea!: HTMLTextAreaElement;

    @state()
    private _view: ViewState = {kind: "idle"};

    static styles = css`
        :host {
            --main-color: var(--altshift-main-color);
            --text-color: var(--altshift-text-color);
            --border-width: var(--altshift-border-width);
            --border-color: var(--altshift-border-color);
            --muted-color: color-mix(in srgb, var(--text-color) 65%, transparent);
            --rule-color: color-mix(in srgb, var(--border-color) 20%, transparent);
            --high-color: var(--altshift-red);
            --medium-color: var(--altshift-orange);
            --low-color: var(--text-color);
            --info-color: var(--muted-color);

            display: flex;
            flex-direction: column;
            gap: 2rem;
        }

        .intro {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
            max-width: 46rem;

            h1 {
                margin: 0;
            }

            p {
                margin: 0;
                line-height: 1.6;
            }

            .local {
                padding-left: 0.875rem;
                border-left: calc(2 * var(--border-width)) solid var(--altshift-orange);
                color: var(--muted-color);
            }
        }

        .columns {
            display: grid;
            grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
            align-items: start;
            gap: 2.5rem;

            @media screen and (max-width: 1280px) {
                grid-template-columns: minmax(0, 1fr);
            }
        }

        .input {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;

            /* The findings run long; the headers they are about stay in view beside them. */
            position: sticky;
            top: 1.5rem;

            @media screen and (max-width: 1280px) {
                position: static;
            }

            textarea {
                height: 26rem;
                resize: vertical;
                background-color: var(--main-color);
                color: var(--text-color);
                border: var(--border-width) solid var(--border-color);
                padding: 0.75rem 1rem;
                font-family: monospace;
                font-size: 0.875rem;
                line-height: 1.5;
                /* A policy runs to hundreds of characters, which is read whole rather than scrolled to. */
                white-space: pre-wrap;
                overflow-wrap: anywhere;

                &:focus-visible {
                    outline: var(--text-color) solid calc(.5 * var(--border-width));
                }

                &.invalid {
                    border-color: var(--high-color);
                    outline-color: var(--high-color);
                }
            }

            altshift-button {
                width: fit-content;
                --altshift-text-box-font-size: 1rem;
                --altshift-text-box-padding: 0.375rem 1rem;
            }
        }

        .heading {
            font-weight: 700;
        }

        .output {
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            min-width: 0;
        }

        .notice {
            margin: 0;
            line-height: 1.6;
            color: var(--muted-color);

            &.error {
                padding-left: 0.875rem;
                border-left: calc(2 * var(--border-width)) solid var(--high-color);
                color: var(--text-color);
            }
        }

        .caption {
            margin-top: -1rem;
            font-size: 0.875rem;
        }

        /* The lines between the cells are the grid's own background showing through its gaps, so
           they hold whether the cells sit in one row or two. */
        .counts {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: var(--border-width);
            margin: 0;
            border: var(--border-width) solid var(--border-color);
            background-color: var(--border-color);

            @media screen and (max-width: 640px) {
                grid-template-columns: repeat(2, minmax(0, 1fr));
            }

            > div {
                display: flex;
                flex-direction: column;
                gap: 0.125rem;
                padding: 0.75rem 1rem;
                background-color: var(--main-color);

                &.empty > * {
                    opacity: 0.4;
                }
            }

            dt {
                order: 2;
                font-size: 0.75rem;
                font-weight: 700;
                letter-spacing: 0.08em;
                text-transform: uppercase;
            }

            dd {
                order: 1;
                margin: 0;
                font-size: 2rem;
                font-weight: 900;
                line-height: 1;
                font-variant-numeric: tabular-nums;
            }

            .error dd {
                color: var(--high-color);
            }

            .warning dd {
                color: var(--medium-color);
            }
        }

        .group {
            --level-color: var(--low-color);

            &.error {
                --level-color: var(--high-color);
            }

            &.warning {
                --level-color: var(--medium-color);
            }

            &.none {
                --level-color: var(--info-color);
            }

            h2 {
                display: flex;
                align-items: center;
                gap: 0.5rem;
                margin: 0 0 0.5rem;
                font-size: 0.8125rem;
                font-weight: 900;
                letter-spacing: 0.08em;
                text-transform: uppercase;

                &::before {
                    content: "";
                    width: 0.625rem;
                    height: 0.625rem;
                    background-color: var(--level-color);
                }
            }

            ul {
                margin: 0;
                padding: 0;
                list-style: none;
                border: var(--border-width) solid var(--border-color);
            }

            li + li {
                border-top: var(--border-width) solid var(--rule-color);
            }
        }

        details {
            summary {
                display: grid;
                grid-template-columns: 1rem minmax(0, 1fr);
                column-gap: 0.5rem;
                padding: 0.75rem 1rem;
                cursor: pointer;
                list-style: none;

                &::-webkit-details-marker {
                    display: none;
                }

                &::before {
                    content: "";
                    grid-row: 1;
                    align-self: center;
                    width: 0.4rem;
                    height: 0.4rem;
                    margin-left: 0.125rem;
                    border-right: var(--border-width) solid var(--text-color);
                    border-bottom: var(--border-width) solid var(--text-color);
                    transform: rotate(-45deg);
                    transition: transform 0.15s ease;
                }

                &:hover .title {
                    text-decoration: underline;
                    text-underline-offset: 0.2em;
                }

                &:focus-visible {
                    outline: var(--text-color) solid calc(.5 * var(--border-width));
                    outline-offset: calc(-1 * var(--border-width));
                }
            }

            &[open] summary::before {
                transform: rotate(45deg);
            }

            .title {
                font-weight: 700;
                line-height: 1.4;
            }

            .location {
                grid-column: 2;
                margin-top: 0.25rem;
                overflow: hidden;
                font-family: monospace;
                font-size: 0.8125rem;
                color: var(--muted-color);
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .body {
                display: flex;
                flex-direction: column;
                gap: 0.75rem;
                padding: 0 1rem 1rem 2.5rem;

                p {
                    margin: 0;
                    line-height: 1.6;
                }
            }

            dl {
                display: grid;
                grid-template-columns: max-content minmax(0, 1fr);
                gap: 0.25rem 1rem;
                margin: 0;
                font-size: 0.875rem;
            }

            dt {
                color: var(--muted-color);
            }

            dd {
                margin: 0;
                font-family: monospace;
                overflow-wrap: anywhere;
            }

            .rule-id {
                font-family: monospace;
                font-size: 0.75rem;
                color: var(--muted-color);
            }
        }
    `;

    connectedCallback(): void {
        super.connectedCallback();
        // Loaded ahead of the first paste, so it is ready by then.
        this.#session.start().catch(() => undefined);
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this.#session.close();
    }

    private _input = () => {
        void this.#session.update(this._textarea.value);
    };

    private _loadExample = () => {
        this._textarea.value = exampleHeaders;
        this._input();
        this._textarea.focus();
    };

    private _renderFinding(finding: Finding) {
        const location = findingLocation(finding);
        const details = findingDetails(finding).filter(detail => detail.label !== "Header");

        return html`
            <li>
                <details>
                    <summary>
                        <span class="title">${finding.title}</span>
                        ${location ? html`<span class="location" title=${location}>${location}</span>` : nothing}
                    </summary>
                    <div class="body">
                        ${finding.description ? html`<p>${finding.description}</p>` : nothing}
                        ${details.length > 0
                            ? html`<dl>${details.map(detail => html`<dt>${detail.label}</dt><dd>${detail.value}</dd>`)}</dl>`
                            : nothing}
                        <span class="rule-id">${finding.rule_id}</span>
                    </div>
                </details>
            </li>
        `;
    }

    private _renderGroup(group: FindingGroup) {
        return html`
            <section class=${classMap({group: true, [group.level]: true})}>
                <h2>${group.label}</h2>
                <ul>${group.findings.map(finding => this._renderFinding(finding))}</ul>
            </section>
        `;
    }

    private _renderReport(report: Report, groups: FindingGroup[]) {
        return html`
            <dl class="counts" aria-label="Findings by severity">
                ${countLevels(report.findings).map(count => html`
                    <div class=${classMap({[count.level]: true, empty: count.count === 0})}>
                        <dt>${count.label}</dt>
                        <dd>${count.count}</dd>
                    </div>
                `)}
            </dl>
            <p class="notice caption">From ${report.field_count} header ${report.field_count === 1 ? "field" : "fields"}. Select a finding for what it means.</p>
            ${report.document
                ? nothing
                : html`<p class="notice">Without a Content-Type, Content-Length or Transfer-Encoding the response is taken to carry no document, as a redirect does not, so the headers that protect one are only informational. Paste the Content-Type too to have them graded.</p>`}
            ${groups.length === 0
                ? html`<p class="notice">Nothing to report in ${report.field_count} header ${report.field_count === 1 ? "field" : "fields"}.</p>`
                : groups.map(group => this._renderGroup(group))}
        `;
    }

    private _renderOutput() {
        const view = this._view;
        switch (view.kind) {
            case "idle":
                return html`<p class="notice">Findings appear here as you paste, grouped by severity.</p>`;
            case "loading":
                return html`<p class="notice">Loading the analyser…</p>`;
            case "invalid":
                return html`<p class="notice error">${view.message}</p>`;
            case "failed":
                return html`<p class="notice error">${view.message} Reloading the page may help.</p>`;
            case "report":
                return this._renderReport(view.report, view.groups);
        }
    }

    render() {
        return html`
            <div class="intro">
                <h1>HTTP header analysis</h1>
                <p>Paste the headers of an HTTP response to see what is wrong with its security headers.</p>
                <p class="local">
                    The analysis runs in your browser, compiled to WebAssembly. Nothing you paste is sent
                    anywhere, so cookies, session ids and internal host names stay with you.
                </p>
            </div>
            <div class="columns">
                <div class="input">
                    <label class="heading" for="headers">Response headers</label>
                    <textarea
                        id="headers"
                        autocomplete="off"
                        spellcheck="false"
                        placeholder="HTTP/2 200&#10;content-type: text/html&#10;strict-transport-security: max-age=63072000"
                        class=${classMap({invalid: this._view.kind === "invalid"})}
                        @input=${this._input}
                    ></textarea>
                    <altshift-button type="button" @click=${this._loadExample}>Try an example</altshift-button>
                </div>
                <div class="output" aria-live="polite">
                    ${this._renderOutput()}
                </div>
            </div>
        `;
    }
}
