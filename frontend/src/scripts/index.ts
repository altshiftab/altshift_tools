import {addErrorEventListeners, setUpSpaRouting} from "@altshiftab/http_service_utils_js";
import {html, render} from "lit";

import "@altshiftab/styles/common_web.css";
import "@altshiftab/styles/common_header_footer.css";
import "@altshiftab/web_components/header";
import "@altshiftab/web_components/footer";
import "@altshiftab/web_components/box";
import {
    darkClassName,
    darkThemeValue,
    lightClassName,
    localStorageThemeKey,
    prefersDarkTheme
} from "@altshiftab/web_components/theme_toggler"
import {ToggledEvent, toggledSwitchEventType} from "@altshiftab/web_components/switch";

addErrorEventListeners();

const useDarkTheme = prefersDarkTheme();
const [classToAdd, classToRemove] = useDarkTheme ? ["dark", "light"] : ["light", "dark"];

document.documentElement.classList.add(classToAdd);
document.documentElement.classList.remove(classToRemove);

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

addEventListener("DOMContentLoaded", () => {
    const themeTogglerContainer = document.querySelector(".theme-toggler-container");
    if (!(themeTogglerContainer instanceof HTMLElement))
        throw new Error("theme toggler container not found");

    render(
        html`<theme-toggler ?useDarkTheme="${useDarkTheme}"></theme-toggler>`,
        themeTogglerContainer
    )
});

addEventListener(toggledSwitchEventType, event => {
    const themeValue = (event as ToggledEvent).detail.value ?? "";
    localStorage.setItem(localStorageThemeKey, themeValue);

    const [classToAdd, classToRemove] = themeValue === darkThemeValue
        ? [darkClassName, lightClassName]
        : [lightClassName, darkClassName]
    ;

    for (const element of [document.documentElement]) {
        element.classList.add(classToAdd);
        element.classList.remove(classToRemove);
    }
});

