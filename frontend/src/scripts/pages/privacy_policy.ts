import {customElement} from "lit/decorators.js";
import {css, LitElement} from "lit";
import {privacyPolicy} from "@altshiftab/web_components/privacy_policy";

@customElement("privacy-policy-content")
export default class PrivacyPolicyContent extends LitElement {
    static styles = css`
        :host {
            display: flex;
            flex-direction: column;
            gap: 1rem;

            max-width: 45rem;

            h1 {
                margin: 0;
            }

            h2 {
                margin: 1rem 0 0;
            }

            p {
                margin: 0;
                line-height: 1.6;
            }

            a {
                color: var(--altshift-text-color);
            }
        }
    `;

    render() {
        return privacyPolicy();
    }
}
