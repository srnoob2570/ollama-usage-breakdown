// ==UserScript==
// @name         Ollama Usage Breakdown
// @namespace    https://github.com/srnoob2570
// @version      1.3.4
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

    // ---- This script's own markers ---------------------------------------
    // Attributes and ids this script puts on its own nodes, so refreshes can
    // find and undo their work. Ollama never renders these.
    const PANEL = "data-oue-panel";
    const PCT_MARK = "data-oue-pct";
    const COUNT_MARK = "data-oue-num";
    const STYLE_ID = "ollama-usage-enhancer-styles";

    // ---- The ollama.com markup contract ----------------------------------
    // Everything this script matches against or reads on Ollama's /settings
    // page. If Ollama changes their markup, this block is the only place
    // that should need edits.
    const OLLAMA = {
        track: "[data-usage-track]",                   // usage meter bar
        segment: "[data-usage-segment]",               // one per-model slice of a bar
        meter: "[data-usage-meter]",                   // wrapper element around a track
        localTime: ".local-time[data-time]",           // "Resets in ..." line
        weeklyListId: "weekly-usage-models",           // native weekly list container
        weeklyHeading: "Models used this week",        // its heading text
        sessionLabel: /session/i,                      // track aria-label "Session usage ..."
        weeklyLabel: /weekly/i,                        // track aria-label "Weekly usage ..."
        requestsAttr: "data-requests",                 // per-segment request count
        modelAttr: "data-model",                       // per-segment model name
        timeAttr: "data-time",                         // absolute reset timestamp
        countLabel: /(\d[\d.,]*)\s+requests?/i,        // aria-label "... 42 requests"
        countSuffix: /:\s*\d[\d.,]*\s+requests?\s*$/i, // that suffix, stripped from names
    };

    // Session panel per track; a WeakMap lets removed tracks be collected.
    const panels = new WeakMap();
    const numberFormat = new Intl.NumberFormat(
        document.documentElement.lang || undefined,
    );
    // Reset timestamps are pinned to en-US so they do not vary with page locale.
    const resetFormat = new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });

    let refreshQueued = false;

    // Ollama ships a compiled Tailwind build, so arbitrary utilities like
    // min-w-[5.5rem] are not guaranteed to exist; a style block is reliable.
    function addStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
      .oue-num { min-width: 5.5rem; text-align: right; }
      .oue-pct { min-width: 3.5rem; text-align: right; }
      /* Keep the native weekly list in step with the session panel's spacing. */
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

    // "84.2%" or "84,2%" -> 84.2, else null.
    function percentFrom(text) {
        const match = text?.match(/(-?\d+(?:[.,]\d+)?)\s*%/);
        return match ? Number(match[1].replace(",", ".")) : null;
    }

    // Overall usage Ollama reports in the track's aria-label
    // ("Session usage 10.7% used" -> 10.7).
    const overallUsage = (track) => percentFrom(track.getAttribute("aria-label"));

    // Turn each usage segment into a record. Ollama exposes each model's
    // share only as the segment width, and those widths are shares of the
    // used portion (they sum to 100%). Rescaling by the overall "X% used"
    // measures every model against the total limit, so the results sum to X.
    function readSegments(track, share) {
        return [...track.querySelectorAll(OLLAMA.segment)].map(
            (segment, index) => {
                // Request count: data-requests when it is a plain number, else
                // the aria-label ("42 requests"). Separators are stripped, so
                // "1,234" parses as 1234.
                const attr = segment.getAttribute(OLLAMA.requestsAttr)?.trim();
                const raw = /^\d[\d.,\s]*$/.test(attr || "")
                    ? attr
                    : segment
                          .getAttribute("aria-label")
                          ?.match(OLLAMA.countLabel)?.[1];
                const parsed = raw ? Number(raw.replace(/\D/g, "")) : null;

                // Name: data-model, then the aria-label minus its
                // "N requests" suffix, then a positional fallback.
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

    // Label for a segment record: the rescaled percentage with two decimals
    // (nonzero values that round down to "0.00" show as "<0.01%"), falling
    // back to Ollama's raw width.
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

    // Appends the absolute reset time to each .local-time[data-time]. Ollama
    // rewrites the relative text in place as it ticks, so the last seen
    // relative text is kept on the element itself (data-oue-relative-text)
    // and re-derived whenever the displayed text differs from what this
    // script last wrote.
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

    // Renders the "Models used this session" list with the same markup Ollama
    // uses for its native weekly list, plus a percentage column. The panel is
    // cached per track, placed after the meter's reset time when one exists
    // (after the track otherwise), and rebuilt from scratch on every pass.
    function renderSessionList(track, segments) {
        let panel = panels.get(track);
        if (!panel) {
            panel = document.createElement("div");
            panel.id = "session-usage-models";
            panel.setAttribute(PANEL, "");
            panel.className = "mt-5 space-y-1.5";
            panels.set(track, panel);
        }

        const meter = track.closest(OLLAMA.meter);
        const resetTime = meter?.nextElementSibling?.matches(OLLAMA.localTime)
            ? meter.nextElementSibling
            : null;
        if ((resetTime || track).nextElementSibling !== panel) {
            (resetTime || track).after(panel);
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
                element(
                    "span",
                    "oue-pct flex-none tabular-nums text-neutral-400",
                    usageLabel(item),
                ),
            );
            panel.append(row);
        }
        return panel;
    }

    // Injects per-model percentages into Ollama's native weekly list and
    // aligns its request counts into the fixed-width column the session list
    // uses. Rows whose model has no matching segment are reverted. The list
    // is found by its well-known id, else as the parent of the div whose text
    // is the weekly heading.
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
                pct = element(
                    "span",
                    "oue-pct flex-none tabular-nums text-neutral-400",
                );
                pct.setAttribute(PCT_MARK, "");
                (countSpan || nameSpan).after(pct);
            }
            if (pct.textContent !== labelsByName.get(name)) {
                pct.textContent = labelsByName.get(name);
            }
        }
    }

    // Removes or reverts everything this script added; runs when the page is
    // somewhere other than /settings.
    function cleanup() {
        document
            .querySelectorAll(`[${PANEL}],[${PCT_MARK}]`)
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

    // Reconcile the page with the desired enhancements; safe to run often.
    // When no aria-label matches, the first track that is not clearly the
    // other meter is treated as session, and the next one as weekly.
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

    // Coalesces bursts of mutations into one pass. rAF does not fire while the
    // tab is hidden, so background updates use a timer instead.
    function scheduleRefresh() {
        if (refreshQueued) return;
        refreshQueued = true;
        if (document.hidden) setTimeout(refresh, 500);
        else requestAnimationFrame(refresh);
    }

    // Whether a mutated node belongs to this script's own additions, so the
    // observer ignores self-inflicted mutations. The one write this cannot
    // cover (text inside Ollama's reset-time nodes) converges after a single
    // idempotent pass.
    function isOwnChange(node) {
        return (
            node instanceof Element &&
            (node.hasAttribute(PANEL) ||
                node.hasAttribute(PCT_MARK) ||
                node.closest(`[${PANEL}],[${PCT_MARK}]`) !== null)
        );
    }

    new MutationObserver((mutations) => {
        const externalChange = mutations.some(
            ({ target, addedNodes, removedNodes }) => {
                if (
                    target instanceof Element &&
                    target.closest(`[${PANEL}],[${PCT_MARK}]`)
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

    // The observer covers content swaps; these cover the navigation event.
    window.addEventListener("popstate", scheduleRefresh);
    window.addEventListener("hashchange", scheduleRefresh);
    window.navigation?.addEventListener?.("navigate", scheduleRefresh);
    scheduleRefresh();
})();
