import {addErrorEventListeners} from "@altshiftab/utils/browser/error_reporting";
import {setUpSpaRouting} from "@altshiftab/utils/browser/routing";
import {render} from "lit";

import "@altshiftab/styles/common_web.css";
import "@altshiftab/styles/common_header_footer.css";
import "@altshiftab/web_components/header";
import "@altshiftab/web_components/footer";
import "@altshiftab/web_components/box";
import {applyTheme} from "@altshiftab/web_components/theme_toggler"

addErrorEventListeners();

applyTheme();

setUpSpaRouting(
    // "/" is only the root-path anchor the routing helper requires; the backend serves no document there.
    ["/", "/str", "/fingerprint", "/privacy-policy"],
    name => import(`./pages/${name}.ts`),
    renderableValue => {
        const mainElement = document.querySelector("main");
        if (!mainElement)
            throw new Error("main element not found");

        render(renderableValue, mainElement as HTMLElement);
        document.body.classList.remove("loading");
    }
);
