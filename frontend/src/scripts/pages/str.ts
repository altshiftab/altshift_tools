import {customElement, query, state} from "lit/decorators.js";
import {css, html, LitElement} from "lit";
import {classMap} from "lit/directives/class-map.js";

const lastFunctionIdentifier = 'last_function';

async function hashHex(message: string, algorithm: AlgorithmIdentifier) {
    return Array.from(
        new Uint8Array(
            await crypto.subtle.digest(algorithm,
                new TextEncoder().encode(message)
            )
        )
    ).map((b) => b.toString(16).padStart(2, "0")).join('');
}

@customElement("str-content")
export default class StrContent extends LitElement {
    private _lastFunction = localStorage.getItem(lastFunctionIdentifier);
    private _focusAfterSelect: boolean = false;

    @query("select")
    private _selectElement!: HTMLSelectElement;

    @query(".input-container > textarea")
    private _inputContainerTextarea!: HTMLTextAreaElement;

    @state()
    private _outputValue: string = "";

    @state()
    private _inputError: boolean = false;

    static styles = css`
        :host {
            --main-color: var(--altshift-main-color);
            --text-color: var(--altshift-text-color);
            --border-width: var(--altshift-border-width);
            --border-color: var(--altshift-border-color);
            
            display: flex;
            flex-direction: column;
            gap: 1rem;
            
            > .select-container {
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
            }
            
            > .input-output-container {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 1rem;
                min-height: 20rem;

                @media screen and (max-width: 1280px) {
                    grid-template-columns: 1fr;
                }
                
                > :is(.input-container, .output-container) {
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                }
                
                > .input-container > textarea.error {
                    outline-color: #E20F1C;
                    border-color: #E20F1C;
                }
            }

            label {
                font-weight: bold;
            }
            
            textarea {
                height: 100%;
                resize: vertical;
            }
            
            textarea, select {
                background-color: var(--main-color);
                color: var(--text-color);
                padding: .5rem 1rem;
                border: var(--border-width) solid var(--border-color);
                font-family: inherit;
                
                &:focus-visible {
                    outline: var(--text-color) solid calc(.5 * var(--border-width));
                }
            }
        }
    `;

    firstUpdated() {
        const lastFunction = this._lastFunction;
        if (lastFunction) {
            const option = this._selectElement.querySelector(`option[value="${lastFunction}"]`);
            if (option) {
                (option as HTMLOptionElement).selected = true;
                this._selectElement.value = lastFunction;
            }
        }
    }

    private _selectPointerDown = (event: PointerEvent) => {
        if (event.pointerType === "mouse" || event.pointerType === "touch") {
            this._focusAfterSelect = true;
        }
    }

    private _inputChange = async () => {
        const functionInput = this._inputContainerTextarea.value;
        this._inputError = false;

        const functionName = this._selectElement.value
        if (functionName === "")
            return;

        switch (functionName) {
            case "encode-base64": {
                try {
                    this._outputValue = btoa(functionInput);
                } catch {
                    this._inputError = true;
                    this._outputValue = "";
                }
                return;
            }
            case "decode-base64": {
                try {
                    this._outputValue = atob(functionInput);
                } catch {
                    this._inputError = true;
                    this._outputValue = "";
                }
                return;
            }
            case "SHA-1":
            case "SHA-256":
            case "SHA-512":
                this._outputValue = await hashHex(functionInput, functionName)
                return;
            case "json-escape":
                try {
                    this._outputValue = JSON.stringify(functionInput).slice(1, -1);
                } catch {
                    this._inputError = true;
                    this._outputValue = "";
                }
                return;
            case "lines-to-json-array":
                try {
                    this._outputValue = JSON.stringify(functionInput.split("\n"));
                } catch {
                    this._inputError = true;
                    this._outputValue = "";
                }
                return;
            case "json-array-to-lines":
                try {
                    this._outputValue = JSON.parse(functionInput).join("\n");
                } catch {
                    this._inputError = true;
                    this._outputValue = "";
                }
                return;
            case "length":
                this._outputValue = functionInput.length.toString();
                return;
            case "deindent":
                const lines = functionInput.split("\n");
                let num_characters_to_remove = Math.min(
                    ...lines.map(line => line.match(/^\s+/)).filter(match => match !== null).map(match => match[0].length)
                );
                num_characters_to_remove = num_characters_to_remove === Infinity ? 0 : num_characters_to_remove;
                return this._outputValue = lines.map(line => line.slice(num_characters_to_remove)).join("\n");
            default: {
                throw new Error(`Unexpected function: ${functionName}`);
            }
        }
    }

    private _selectChange = () => {
        localStorage.setItem(lastFunctionIdentifier, this._selectElement.value);
        this._inputChange();

        if (this._focusAfterSelect) {
            this._inputContainerTextarea.focus();
            this._focusAfterSelect = false;
        }
    }

    render() {
        return html`
            <div class="select-container">
                <label>Function</label>
                <select @pointerdown=${this._selectPointerDown} @change=${this._selectChange}>
                    <optgroup label="Decode">
                        <option value="decode-base64">Decode Base64</option>
                    </optgroup>
                    <optgroup label="Encode">
                        <option value="encode-base64">Encode Base64</option>
                    </optgroup>
                    <optgroup label="Hash">
                        <option value="SHA-1">sha1</option>
                        <option value="SHA-256">sha256</option>
                        <option value="SHA-512">sha512</option>
                    </optgroup>
                    <optgroup label="JSON">
                        <option value="json-escape">Escape JSON</option>
                        <option value="lines-to-json-array">Make an array from lines</option>
                        <option value="json-array-to-lines">Make lines from an array</option>
                    </optgroup>
                    <optgroup label="Other">
                        <option value="length">Length</option>
                        <option value="deindent">Deindent</option>
                    </optgroup>
                </select>
            </div>

            <div class="input-output-container">
                <div class="input-container">
                    <label>Input</label>
                    <textarea autocomplete="off" spellcheck="false" autofocus @input=${this._inputChange} class=${classMap({error: this._inputError})}></textarea>
                </div>
                <div class="output-container">
                    <label>Output</label>
                    <textarea readonly .value=${this._outputValue}></textarea>
                </div>
            </div>
        `;
    }
}
