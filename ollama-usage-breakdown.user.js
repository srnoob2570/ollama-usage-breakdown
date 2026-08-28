// ==UserScript==
// @name         Ollama Usage Breakdown
// @namespace    https://github.com/srnoob2570
// @version      1.3.5
// @description  Adds an Ollama-style per-model session breakdown and inline per-model usage percentages.
// @author       srnoob2570
// @match        https://ollama.com/settings
// @homepageURL  https://github.com/srnoob2570/ollama-usage-breakdown
// @supportURL   https://github.com/srnoob2570/ollama-usage-breakdown/issues
// @updateURL    https://raw.githubusercontent.com/srnoob2570/ollama-usage-breakdown/main/ollama-usage-breakdown.user.js
// @downloadURL  https://raw.githubusercontent.com/srnoob2570/ollama-usage-breakdown/main/ollama-usage-breakdown.user.js
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

// Enhances the usage meters on ollama.com/settings: adds a per-model session
// list under the session meter, injects per-model percentages into the native
// weekly list, and appends absolute reset times. All data is parsed from the
// DOM (aria-labels, segment widths, data attributes); no API calls. The page
// re-renders itself in place, so refresh() re-derives everything from scratch
// on every pass, and cleanup only touches nodes this script marked.

(() => {
    "use strict";

    const PANEL = "data-oue-panel";
    const PCT_MARK = "data-oue-pct";
    const COUNT_MARK = "data-oue-num";
    const STYLE_ID = "ollama-usage-enhancer-styles";
    const OWN_MARKS = `[${PANEL}],[${PCT_MARK}]`;
    const PCT_CLASS = "oue-pct flex-none tabular-nums text-neutral-400";

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
    const numberFormat = new Intl.NumberFormat(
        document.documentElement.lang || undefined,
    );
    const resetFormat = new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });

    let refreshQueued = false;

    function addStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
      .oue-num { min-width: 5.5rem; text-align: right; }
      .oue-pct { min-width: 3.5rem; text-align: right; }
      #${OLLAMA.weeklyListId} { margin-top: 1.25rem; }
    `;
        (document.head || document.documentElement).append(style);
    }

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function percentFrom(text) {
        const match = text?.match(/(-?\d+(?:[.,]\d+)?)\s*%/);
        return match ? Number(match[1].replace(",", ".")) : null;
    }

    const overallUsage = (track) => percentFrom(track.getAttribute("aria-label"));

    function readSegments(track, share) {
        return [...track.querySelectorAll(OLLAMA.segment)].map(
            (segment, index) => {
                const attr = segment.getAttribute(OLLAMA.requestsAttr)?.trim();
                const raw = /^\d[\d.,\s]*$/.test(attr || "")
                    ? attr
                    : segment
                          .getAttribute("aria-label")
                          ?.match(OLLAMA.countLabel)?.[1];
                const parsed = raw ? Number(raw.replace(/\D/g, "")) : null;

                const name =
                    segment.getAttribute(OLLAMA.modelAttr)?.trim() ||
                    segment
                        .getAttribute("aria-label")
                        ?.replace(OLLAMA.countSuffix, "")
                        .trim() ||
                    `Model ${index + 1}`;

                const width = segment.style.width.trim();
                const widthPercent = percentFrom(width);
                const color = getComputedStyle(segment).backgroundColor;
                return {
                    name,
                    requests:
                        parsed !== null && Number.isSafeInteger(parsed)
                            ? parsed
                            : null,
                    width,
                    absolute:
                        widthPercent !== null && share !== null
                            ? (widthPercent * share) / 100
                            : null,
                    color:
                        !color ||
                        color === "transparent" ||
                        color === "rgba(0, 0, 0, 0)"
                            ? "currentColor"
                            : color,
                };
            },
        );
    }

    function usageLabel(item) {
        if (item.absolute === null) return item.width || "—";
        if (item.absolute === 0) return "0%";
        const rounded = item.absolute.toFixed(2);
        return rounded === "0.00" ? "<0.01%" : `${rounded}%`;
    }

    function findTrack(pattern, tracks) {
        return (
            tracks.find((track) =>
                pattern.test(track.getAttribute("aria-label") || ""),
            ) || null
        );
    }

    function enhanceResetTimes() {
        document.querySelectorAll(OLLAMA.localTime).forEach((time) => {
            const resetAt = new Date(time.getAttribute(OLLAMA.timeAttr));
            const currentText = time.textContent.trim();
            if (Number.isNaN(resetAt.getTime()) || !currentText) return;

            const relativeText =
                currentText !== time.dataset.oueResetDisplay
                    ? currentText
                    : time.dataset.oueRelativeText || currentText;
            const display = `${relativeText} (${resetFormat.format(resetAt)})`;

            if (currentText !== display) time.textContent = display;
            time.dataset.oueRelativeText = relativeText;
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

        panel.replaceChildren();
        panel.append(
            element("div", "text-xs text-neutral-500", "Models used this session"),
        );
        for (const item of segments) {
            const count =
                item.requests === null
                    ? "—"
                    : `${numberFormat.format(item.requests)} ${
                        item.requests === 1 ? "request" : "requests"
                    }`;
            const row = element("div", "flex min-w-0 items-center gap-2 text-xs");
            const dot = element("span", "h-2 w-2 flex-none rounded-sm");
            const name = element(
                "span",
                "min-w-0 flex-1 truncate text-neutral-700",
                item.name,
            );
            dot.style.background = item.color;
            dot.setAttribute("aria-hidden", "true");
            name.title = item.name;
            row.append(
                dot,
                name,
                element(
                    "span",
                    "oue-num flex-none tabular-nums text-neutral-400",
                    count,
                ),
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
            const countSpan = [...row.querySelectorAll("span.tabular-nums")].find(
                (span) => !span.hasAttribute(PCT_MARK),
            );

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

    function cleanup() {
        document
            .querySelectorAll(OWN_MARKS)
            .forEach((node) => node.remove());
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

        if (!/^\/settings$/.test(location.pathname)) {
            cleanup();
            return;
        }

        addStyles();
        enhanceResetTimes();

        const tracks = [...document.querySelectorAll(OLLAMA.track)];
        const label = (track) => track.getAttribute("aria-label") || "";
        const sessionTrack =
            findTrack(OLLAMA.sessionLabel, tracks) ||
            tracks.find((track) => !OLLAMA.weeklyLabel.test(label(track))) ||
            null;
        const weeklyTrack =
            findTrack(OLLAMA.weeklyLabel, tracks) ||
            tracks.find(
                (track) =>
                    track !== sessionTrack &&
                    !OLLAMA.sessionLabel.test(label(track)),
            ) ||
            null;

        const activePanels = new Set();

        if (sessionTrack) {
            const segments = readSegments(
                sessionTrack,
                overallUsage(sessionTrack),
            );
            if (segments.length) {
                activePanels.add(renderSessionList(sessionTrack, segments));
            }
        }
        if (weeklyTrack) {
            enhanceWeeklyList(
                readSegments(weeklyTrack, overallUsage(weeklyTrack)),
            );
        }

        document.querySelectorAll(`[${PANEL}]`).forEach((panel) => {
            if (!activePanels.has(panel)) panel.remove();
        });
    }

    function scheduleRefresh() {
        if (refreshQueued) return;
        refreshQueued = true;
        if (document.hidden) setTimeout(refresh, 500);
        else requestAnimationFrame(refresh);
    }

    function isOwnChange(node) {
        return (
            node instanceof Element &&
            (node.hasAttribute(PANEL) ||
                node.hasAttribute(PCT_MARK) ||
                node.closest(OWN_MARKS) !== null)
        );
    }

    new MutationObserver((mutations) => {
        const externalChange = mutations.some(
            ({ target, addedNodes, removedNodes }) => {
                if (
                    target instanceof Element &&
                    target.closest(OWN_MARKS)
                ) {
                    return false;
                }
                const changed = [...addedNodes, ...removedNodes];
                return !(changed.length && changed.every(isOwnChange));
            },
        );
        if (externalChange) scheduleRefresh();
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
    scheduleRefresh();
})();
