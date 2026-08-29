// ==UserScript==
// @name         Ollama Usage Breakdown
// @namespace    https://github.com/srnoob2570
// @version      1.3.8
// @description  Adds an Ollama-style per-model session breakdown, inline per-model usage percentages, and an opt-in dark theme for ollama.com.
// @author       srnoob2570
// @license      MIT
// @match        https://ollama.com/*
// @homepageURL  https://github.com/srnoob2570/ollama-usage-breakdown
// @supportURL   https://github.com/srnoob2570/ollama-usage-breakdown/issues
// @updateURL    https://raw.githubusercontent.com/srnoob2570/ollama-usage-breakdown/main/ollama-usage-breakdown.user.js
// @downloadURL  https://raw.githubusercontent.com/srnoob2570/ollama-usage-breakdown/main/ollama-usage-breakdown.user.js
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

// Enhances the usage meters on ollama.com/settings: adds a per-model session
// list under the session meter, injects per-model percentages into the native
// weekly list, and appends absolute reset times. All data is parsed from the
// DOM (aria-labels, segment widths, data attributes); no API calls. The page
// re-renders itself in place, so refresh() re-derives everything from scratch
// on every pass, and cleanup only touches nodes this script marked. A floating
// toggle on every ollama.com page enables an opt-in dark theme across the
// site, persisted in localStorage; the usage-meter features stay on /settings.

(() => {
    "use strict";

    const PANEL = "data-oue-panel";
    const PCT_MARK = "data-oue-pct";
    const COUNT_MARK = "data-oue-num";
    const STYLE_ID = "ollama-usage-enhancer-styles";
    const THEME_MARK = "data-oue-theme";
    const THEME_STYLE_ID = "oue-theme-styles";
    const THEME_CLASS = "oue-dark";
    const THEME_KEY = "oue-theme";
    const OWN_MARKS = `[${PANEL}],[${PCT_MARK}],[${THEME_MARK}]`;
    const NUM_CLASS = "flex-none tabular-nums text-neutral-400";
    const PCT_CLASS = `oue-pct ${NUM_CLASS}`;

    // Dark-theme palette: each row is [selector, declaration], scoped as
    // `html.oue-dark .<selector>` (comma groups each get the prefix) with
    // !important. Button/icon/form chrome stays hand-written in THEME_CSS.
    const DARK_RULES = [
        ["bg-white", "background-color: #121213"], ["bg-neutral-50", "background-color: #1a1a1b"],
        ["bg-neutral-100", "background-color: #212122"], ["bg-neutral-200", "background-color: #2e2e2f"],
        ["bg-neutral-300", "background-color: #3c3c3d"], ["bg-neutral-400", "background-color: #4a4a4b"],
        ["bg-neutral-800", "background-color: #e8e8e9"], ["bg-neutral-900", "background-color: #f0f0f1"],
        ["bg-black", "background-color: #f0f0f1"],
        ["hover\\:bg-black:hover, focus\\:bg-black:focus", "background-color: #dededf"],
        ["bg-black\\/5", "background-color: rgba(255, 255, 255, 0.07)"],
        ["hover\\:bg-black\\/10:hover", "background-color: rgba(255, 255, 255, 0.08)"],
        ["bg-white\\/95", "background-color: rgba(30, 30, 31, 0.96)"],
        ["bg-neutral-50\\/50", "background-color: rgba(26, 26, 27, 0.55)"],
        ["text-black\\/65", "color: #a8a8aa"],
        ["hover\\:bg-neutral-50:hover, focus\\:bg-neutral-50:focus", "background-color: #1d1d1e"],
        ["hover\\:bg-neutral-100:hover", "background-color: #242425"],
        ["hover\\:bg-neutral-300:hover", "background-color: #444446"],
        ["hover\\:bg-neutral-800:hover, hover\\:bg-neutral-900:hover", "background-color: #dededf"],
        ["hover\\:bg-white:hover", "background-color: #2a2a2c"],
        ["text-black", "color: #f4f4f5"], ["text-neutral-900", "color: #ebebeb"],
        ["text-neutral-800", "color: #d7d7d8"], ["text-neutral-700", "color: #c2c2c3"],
        ["text-neutral-600", "color: #9a9a9b"], ["text-neutral-500", "color: #8a8a8b"],
        [
            "bg-black.text-white, bg-neutral-800.text-white, bg-neutral-900.text-white, " +
                "bg-black .text-white, bg-neutral-800 .text-white, bg-neutral-900 .text-white",
            "color: #1a1a1b",
        ],
        ["hover\\:text-neutral-600:hover", "color: #b4b4b5"],
        ["hover\\:text-neutral-700:hover", "color: #cfcfd0"],
        ["hover\\:text-neutral-800:hover", "color: #f0f0f1"],
        ["hover\\:text-neutral-900:hover, hover\\:text-black:hover", "color: #f4f4f5"],
        ["group:hover .group-hover\\:text-neutral-900", "color: #f4f4f5"],
        ["bg-indigo-50", "background-color: rgba(99, 102, 241, 0.16)"],
        ["text-indigo-600", "color: #a5b4fc"],
        ["bg-\\[\\#ddf4ff\\]", "background-color: rgba(59, 130, 246, 0.16)"],
        ["text-blue-600", "color: #93c5fd"],
        ["peer:checked ~ .peer-checked\\:bg-neutral-100", "background-color: #212122"],
        ["border-neutral-100", "border-color: #1f1f20"], ["border-neutral-200", "border-color: #2a2a2b"],
        ["border-neutral-300", "border-color: #38383a"], ["border-neutral-800", "border-color: #38383a"],
        ["hover\\:border-black:hover, focus\\:border-black:focus", "border-color: #47474a"],
        ["hover\\:border-neutral-300:hover", "border-color: #4b4b4d"],
        ["focus\\:border-neutral-50:focus", "border-color: #38383a"],
    ];

    const THEME_CSS = `
      .oue-theme-btn {
        position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
        width: 42px; height: 42px; padding: 0; margin: 0;
        display: grid; place-items: center; cursor: pointer; border-radius: 9999px;
        background-color: #ffffff; border: 1px solid #e5e5e5; color: #525252;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06), 0 4px 14px rgba(0, 0, 0, 0.08);
        transition: background-color 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease;
      }
      .oue-theme-btn:hover { background-color: #f5f5f5; border-color: #d4d4d4; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.06), 0 6px 18px rgba(0, 0, 0, 0.1); transform: translateY(-1px); }
      .oue-theme-btn:active { transform: translateY(0) scale(0.96); }
      .oue-theme-btn:focus-visible { outline: 2px solid #737373; outline-offset: 2px; }
      .oue-theme-icon { position: relative; width: 20px; height: 20px; }
      .oue-theme-icon svg { position: absolute; inset: 0; width: 100%; height: 100%; transition: opacity 0.2s ease, transform 0.25s ease; }
      html.oue-dark .oue-moon, html:not(.oue-dark) .oue-sun { opacity: 0; transform: rotate(-90deg) scale(0.4); }

      html.oue-dark .oue-theme-btn { background-color: #1d1d1e; border-color: #343436 !important; color: #d4d4d5; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.45), 0 6px 18px rgba(0, 0, 0, 0.35); }
      html.oue-dark .oue-theme-btn:hover { background-color: #262627; border-color: #454548 !important; }
      html.oue-dark .oue-theme-btn:focus-visible { outline-color: #a3a3a3; }

      html.oue-dark { color-scheme: dark; background-color: #121213; }
      html.oue-dark body { background-color: #121213; color: #f4f4f5; }
      html.oue-dark ::selection { background-color: rgba(238, 238, 240, 0.24); }

      ${DARK_RULES.map(
          ([sel, decl]) =>
              `${sel
                  .split(",")
                  .map((part) => `html.${THEME_CLASS} .${part.trim()}`)
                  .join(", ")} { ${decl} !important; }`,
      ).join("\n")}

      html.oue-dark input:not([type="checkbox"]):not([type="radio"]):not([type="range"]),
      html.oue-dark textarea { background-color: #1d1d1e !important; border-color: #3a3a3c !important; color: #f4f4f5 !important; }
      html.oue-dark input::placeholder, html.oue-dark textarea::placeholder { color: #8a8a8b !important; }
      html.oue-dark button { background-color: #1d1d1e; color: #f4f4f5; }

      html.oue-dark .from-white {
        --tw-gradient-from: #121213 var(--tw-gradient-from-position);
        --tw-gradient-to: rgb(18 18 19 / 0) var(--tw-gradient-to-position);
      }

      html.oue-dark [data-usage-track] { background-color: #2e2e2f !important; }
      html.oue-dark img[src="/public/ollama.png"], html.oue-dark img[src*="/public/logos/"] { filter: invert(1); }
      :where(html.${THEME_CLASS}) * { border-color: #2a2a2b !important; }

      @media (prefers-reduced-motion: reduce) { .oue-theme-btn, .oue-theme-icon svg { transition: none !important; } }
    `;

    const THEME_ICONS =
        `<span class="oue-theme-icon" aria-hidden="true"><svg class="oue-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>` +
        `<svg class="oue-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg></span>`;

    const OLLAMA = {
        track: "[data-usage-track]",
        segment: "[data-usage-segment]",
        meter: "[data-usage-meter]",
        localTime: ".local-time[data-time]",
        weeklyListId: "weekly-usage-models",
        weeklyHeading: "Models used this week",
        sessionLabel: /session/i,
        weeklyLabel: /weekly/i,
        requestsAttr: "data-requests",
        modelAttr: "data-model",
        timeAttr: "data-time",
        countLabel: /(\d[\d.,]*)\s+requests?/i,
        countSuffix: /:\s*\d[\d.,]*\s+requests?\s*$/i,
    };

    const panels = new WeakMap();
    const PCT_RE = /(-?\d+(?:[.,]\d+)?)\s*%/;
    let numberFormat;
    const getNumberFormat = () =>
        (numberFormat ??= new Intl.NumberFormat(
            document.documentElement.lang || undefined,
        ));
    const resetFormat = new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });

    let refreshQueued = false;
    let metersActive = false;

    function addStyle(id, css) {
        if (document.getElementById(id)) return;
        const style = document.createElement("style");
        style.id = id;
        style.textContent = css;
        (document.head || document.documentElement).append(style);
    }

    const addThemeStyles = () => addStyle(THEME_STYLE_ID, THEME_CSS);

    const storedTheme = () => {
        try {
            return localStorage.getItem(THEME_KEY);
        } catch {
            return null;
        }
    };

    function effectiveTheme() {
        return storedTheme() === "dark" ? "dark" : "light";
    }

    function syncTheme() {
        const dark = effectiveTheme() === "dark";
        document.documentElement.classList.toggle(THEME_CLASS, dark);
        document.querySelector(`[${THEME_MARK}]`)?.setAttribute("aria-checked", dark ? "true" : "false");
    }

    function setTheme(theme) {
        try {
            localStorage.setItem(THEME_KEY, theme);
        } catch {}
        syncTheme();
    }

    function ensureThemeButton() {
        let button = document.querySelector(`[${THEME_MARK}]`);
        if (!button && document.body) {
            button = document.createElement("button");
            button.type = "button";
            button.className = "oue-theme-btn";
            button.setAttribute(THEME_MARK, "");
            button.setAttribute("role", "switch");
            button.setAttribute("aria-label", "Toggle dark theme (Ollama Usage Breakdown)");
            button.title = "Dark theme · Ollama Usage Breakdown";
            button.innerHTML = THEME_ICONS;
            button.addEventListener("click", () => {
                setTheme(effectiveTheme() === "dark" ? "light" : "dark");
            });
            document.body.append(button);
        }
        syncTheme();
    }

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function percentFrom(text) {
        const match = text?.match(PCT_RE);
        return match ? Number(match[1].replace(",", ".")) : null;
    }

    const overallUsage = (track) => percentFrom(track.getAttribute("aria-label"));

    const trackByLabel = (tracks, pattern) =>
        tracks.find((track) =>
            pattern.test(track.getAttribute("aria-label") || ""),
        ) || null;

    function readSegments(track, share, details = false) {
        return [...track.querySelectorAll(OLLAMA.segment)].map(
            (segment, index) => {
                const name =
                    segment.getAttribute(OLLAMA.modelAttr)?.trim() ||
                    segment
                        .getAttribute("aria-label")
                        ?.replace(OLLAMA.countSuffix, "")
                        .trim() ||
                    `Model ${index + 1}`;

                const width = segment.style.width.trim();
                const widthPercent = percentFrom(width);
                const item = {
                    name,
                    width,
                    absolute:
                        widthPercent !== null && share !== null
                            ? (widthPercent * share) / 100
                            : null,
                };
                if (details) {
                    const attr = segment.getAttribute(OLLAMA.requestsAttr)?.trim();
                    const raw = /^\d[\d.,\s]*$/.test(attr || "")
                        ? attr
                        : segment.getAttribute("aria-label")?.match(OLLAMA.countLabel)?.[1];
                    const parsed = raw ? Number(raw.replace(/\D/g, "")) : null;
                    const color = getComputedStyle(segment).backgroundColor;
                    item.requests =
                        parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
                    item.color =
                        !color || color === "transparent" || color === "rgba(0, 0, 0, 0)"
                            ? "currentColor"
                            : color;
                }
                return item;
            },
        );
    }

    function usageLabel(item) {
        if (item.absolute === null) return item.width || "—";
        if (item.absolute === 0) return "0%";
        const rounded = item.absolute.toFixed(2);
        return rounded === "0.00" ? "<0.01%" : `${rounded}%`;
    }

    function enhanceResetTimes() {
        document.querySelectorAll(OLLAMA.localTime).forEach((time) => {
            const currentText = time.textContent.trim();
            if (!currentText || currentText === time.dataset.oueResetDisplay) {
                return;
            }
            const resetAt = new Date(time.getAttribute(OLLAMA.timeAttr));
            if (Number.isNaN(resetAt.getTime())) return;

            const display = `${currentText} (${resetFormat.format(resetAt)})`;
            time.textContent = display;
            time.dataset.oueRelativeText = currentText;
            time.dataset.oueResetDisplay = display;
        });
    }

    function renderSessionList(track, segments) {
        let panel = panels.get(track);
        if (!panel) {
            panel = document.createElement("div");
            panel.setAttribute(PANEL, "");
            panel.className = "mt-5 space-y-1.5";
            panels.set(track, panel);
        }

        const meter = track.closest(OLLAMA.meter);
        const resetTime = meter?.nextElementSibling?.matches(OLLAMA.localTime)
            ? meter.nextElementSibling
            : null;
        const anchor = resetTime || track;
        if (anchor.nextElementSibling !== panel) {
            anchor.after(panel);
        }

        const sig = segments
            .map((s) => `${s.name}|${s.requests}|${s.width}|${s.color}`)
            .join("\n");
        if (panel.dataset.oueSig === sig) return panel;
        panel.dataset.oueSig = sig;

        panel.replaceChildren();
        panel.append(
            element("div", "text-xs text-neutral-500", "Models used this session"),
        );
        for (const item of segments) {
            const count =
                item.requests === null
                    ? "—"
                    : `${getNumberFormat().format(item.requests)} ${
                        item.requests === 1 ? "request" : "requests"
                    }`;
            const row = element("div", "flex min-w-0 items-center gap-2 text-xs");
            const dot = element("span", "h-2 w-2 flex-none rounded-sm");
            const name = element("span", "min-w-0 flex-1 truncate text-neutral-700", item.name);
            dot.style.background = item.color;
            dot.setAttribute("aria-hidden", "true");
            name.title = item.name;
            row.append(
                dot,
                name,
                element("span", `oue-num ${NUM_CLASS}`, count),
                element("span", PCT_CLASS, usageLabel(item)),
            );
            panel.append(row);
        }
        return panel;
    }

    function enhanceWeeklyList(segments) {
        const list =
            document.getElementById(OLLAMA.weeklyListId) ||
            [...document.querySelectorAll("div.text-xs")].find(
                (node) => node.textContent.trim() === OLLAMA.weeklyHeading,
            )?.parentElement ||
            null;
        if (!list) return;

        const labelsByName = new Map(
            segments
                .filter((item) => item.width)
                .map((item) => [item.name, usageLabel(item)]),
        );

        for (const row of list.querySelectorAll(":scope > div")) {
            const nameSpan = row.querySelector("span[title]");
            const name =
                nameSpan?.getAttribute("title")?.trim() ||
                nameSpan?.textContent?.trim();
            let pct = row.querySelector(`[${PCT_MARK}]`);
            const countSpan =
                [...row.querySelectorAll("span.tabular-nums")].find(
                    (span) => !span.hasAttribute(PCT_MARK),
                ) || null;

            if (!name || !labelsByName.has(name)) {
                pct?.remove();
                if (countSpan?.hasAttribute(COUNT_MARK)) {
                    countSpan.classList.remove("oue-num");
                    countSpan.removeAttribute(COUNT_MARK);
                }
                continue;
            }

            if (countSpan && !countSpan.hasAttribute(COUNT_MARK)) {
                countSpan.classList.add("oue-num");
                countSpan.setAttribute(COUNT_MARK, "");
            }
            if (!pct) {
                pct = element("span", PCT_CLASS);
                pct.setAttribute(PCT_MARK, "");
                (countSpan || nameSpan).after(pct);
            }
            if (pct.textContent !== labelsByName.get(name)) {
                pct.textContent = labelsByName.get(name);
            }
        }
    }

    function cleanupMeters() {
        if (!metersActive) return;
        metersActive = false;
        document.querySelectorAll(`[${PANEL}],[${PCT_MARK}]`).forEach((node) => node.remove());
        document.querySelectorAll(`[${COUNT_MARK}]`).forEach((span) => {
            span.classList.remove("oue-num");
            span.removeAttribute(COUNT_MARK);
        });
        document.querySelectorAll("[data-oue-relative-text]").forEach((time) => {
            time.textContent = time.dataset.oueRelativeText;
            delete time.dataset.oueRelativeText;
            delete time.dataset.oueResetDisplay;
        });
        document.getElementById(STYLE_ID)?.remove();
    }

    function refresh() {
        refreshQueued = false;

        addThemeStyles();
        ensureThemeButton();

        if (!/^\/settings$/.test(location.pathname)) {
            cleanupMeters();
            return;
        }

        addMeterStyles();
        enhanceResetTimes();

        const tracks = [...document.querySelectorAll(OLLAMA.track)];
        const label = (track) => track.getAttribute("aria-label") || "";
        const sessionTrack =
            trackByLabel(tracks, OLLAMA.sessionLabel) ||
            tracks.find((track) => !OLLAMA.weeklyLabel.test(label(track))) ||
            null;
        const weeklyTrack =
            trackByLabel(tracks, OLLAMA.weeklyLabel) ||
            tracks.find(
                (track) =>
                    track !== sessionTrack &&
                    !OLLAMA.sessionLabel.test(label(track)),
            ) ||
            null;

        let activePanel = null;
        if (sessionTrack) {
            const segments = readSegments(
                sessionTrack,
                overallUsage(sessionTrack),
                true,
            );
            if (segments.length) {
                activePanel = renderSessionList(sessionTrack, segments);
            }
        }
        if (weeklyTrack) {
            enhanceWeeklyList(readSegments(weeklyTrack, overallUsage(weeklyTrack)));
        }

        document.querySelectorAll(`[${PANEL}]`).forEach((panel) => {
            if (panel !== activePanel) panel.remove();
        });
    }

    function addMeterStyles() {
        addStyle(
            STYLE_ID,
            `
      .oue-num { min-width: 5.5rem; text-align: right; }
      .oue-pct { min-width: 3.5rem; text-align: right; }
      #${OLLAMA.weeklyListId} { margin-top: 1.25rem; }
    `,
        );
        metersActive = true;
    }

    function scheduleRefresh() {
        if (refreshQueued) return;
        refreshQueued = true;
        if (document.hidden) setTimeout(refresh, 500);
        else requestAnimationFrame(refresh);
    }

    const isForeign = (node) =>
        !(node instanceof Element) ||
        !(
            node.id === STYLE_ID ||
            node.id === THEME_STYLE_ID ||
            node.hasAttribute(PANEL) ||
            node.hasAttribute(PCT_MARK) ||
            node.closest(OWN_MARKS)
        );

    const hasForeignNode = (list) => {
        for (const node of list) {
            if (isForeign(node)) return true;
        }
        return false;
    };

    new MutationObserver((mutations) => {
        for (const { target, addedNodes, removedNodes } of mutations) {
            if (target instanceof Element && target.closest(OWN_MARKS)) {
                continue;
            }
            if (
                (!addedNodes.length && !removedNodes.length) ||
                hasForeignNode(addedNodes) ||
                hasForeignNode(removedNodes)
            ) {
                scheduleRefresh();
                return;
            }
        }
    }).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
            "aria-label",
            "style",
            OLLAMA.modelAttr,
            OLLAMA.requestsAttr,
            OLLAMA.timeAttr,
        ],
    });

    window.addEventListener("popstate", scheduleRefresh);
    window.addEventListener("hashchange", scheduleRefresh);
    window.navigation?.addEventListener?.("navigate", scheduleRefresh);
    addThemeStyles();
    ensureThemeButton();
    scheduleRefresh();
})();
