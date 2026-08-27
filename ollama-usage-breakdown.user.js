// ==UserScript==
// @name         Ollama Usage Breakdown
// @namespace    https://github.com/srnoob2570
// @version      1.3.3
// @description  Adds an Ollama-style per-model session breakdown and inline per-model usage percentages.
// @author       srnoob2570
// @match        https://ollama.com/settings
// @homepageURL  https://github.com/srnoob2570/ollama-usage-breakdown
// @supportURL   https://github.com/srnoob2570/ollama-usage-breakdown/issues
// @updateURL    https://raw.githubusercontent.com/srnoob2570/ollama-usage-breakdown/main/ollama-usage-breakdown.user.js
// @downloadURL  https://raw.githubusercontent.com/srnoob2570/ollama-usage-breakdown/main/ollama-usage-breakdown.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
    "use strict";

    /**
     * Ollama Usage Breakdown — Tampermonkey userscript.
     *
     * Enhances the usage meters on ollama.com/settings:
     * - adds a per-model "Models used this session" list under the session meter,
     * - injects per-model percentages into the session list and Ollama's native
     *   weekly list, rescaled against the overall "X% used" figure,
     * - shows the absolute reset date/time next to each relative reset.
     *
     * All data is parsed from the page DOM (aria-labels, segment widths, data
     * attributes); the script never calls an Ollama API. The page re-renders
     * itself in place, so refresh() re-derives all state from scratch on every
     * run and its cleanup only removes or reverts nodes this script marked.
     */

    // Selectors into Ollama's markup, plus the marker attributes
    // (data-ollama-usage-enhancer, data-oue-*) that tag every node this script
    // creates or modifies, so refreshes can find their own work and undo it.
    const TRACK = "[data-usage-track]";
    const SEGMENT = "[data-usage-segment]";
    const PANEL = "data-ollama-usage-enhancer";
    const WEEKLY_LIST_ID = "weekly-usage-models";
    const WEEKLY_LIST_LABEL = "Models used this week";
    const SESSION_LIST_LABEL = "Models used this session";
    const PCT_MARK = "data-oue-pct";
    const COUNT_MARK = "data-oue-num";
    const STYLE_ID = "ollama-usage-enhancer-styles";
    // Session panel per track; a WeakMap lets removed tracks be collected.
    const panels = new WeakMap();
    const formatNumber = new Intl.NumberFormat(
        document.documentElement.lang || undefined,
    );
    // formatNumber follows the page language; reset timestamps are pinned to
    // en-US so the appended absolute time does not vary with the page locale.
    const resetTimeFormatter = new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });

    let refreshQueued = false;

    /**
     * Inject the fixed-width numeric column styles once per page.
     *
     * Right-aligned, fixed-width columns keep the request counts and
     * percentages lined up in both breakdowns. Ollama ships a compiled
     * Tailwind build, so arbitrary utilities like `min-w-[5.5rem]` are not
     * guaranteed to exist; a small style block is the safe route.
     */
    function addStyles() {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
      .oue-num { min-width: 5.5rem; text-align: right; }
      .oue-pct { min-width: 3.5rem; text-align: right; }
    `;
        (document.head || document.documentElement).append(style);
    }

    /**
     * Create an element with an optional class and text content.
     *
     * @param {string} tag - Tag name.
     * @param {string} [className] - Class attribute value.
     * @param {string} [text] - Text content, set only when provided.
     * @returns {HTMLElement} The created element.
     */
    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    /**
     * Extract the numeric percentage from a value like "84.2%".
     *
     * Accepts both decimal separators ("84.2%" and "84,2%").
     *
     * @param {string|undefined} value - Text to parse (e.g. a segment's CSS width).
     * @returns {number|null} The percentage, or null when absent or unparseable.
     */
    function percent(value) {
        const match = value?.match(/(-?\d+(?:[.,]\d+)?)\s*%/);
        return match ? Number(match[1].replace(",", ".")) : null;
    }

    /**
     * Read a segment's request count.
     *
     * Prefers the `data-requests` attribute and falls back to the aria-label
     * (e.g. "42 requests"). Non-digit characters such as thousands separators
     * are stripped, so "1,234" parses as 1234.
     *
     * @param {HTMLElement} segment - Usage bar segment.
     * @returns {number|null} Request count, or null when neither source
     *   yields a safe integer.
     */
    function requests(segment) {
        const raw =
            segment.dataset.requests ||
            segment
                .getAttribute("aria-label")
                ?.match(/(\d[\d.,]*)\s+requests?/i)?.[1];
        if (!raw) return null;

        const value = Number(raw.replace(/\D/g, ""));
        return Number.isSafeInteger(value) ? value : null;
    }

    /**
     * Resolve a segment's model name.
     *
     * Order: the `data-model` attribute, then the aria-label with its
     * trailing "N requests" suffix removed, then "Model N" as a positional
     * fallback.
     *
     * @param {HTMLElement} segment - Usage bar segment.
     * @param {number} index - Segment position, used only for the fallback.
     * @returns {string} Display name for the model.
     */
    function modelName(segment, index) {
        return (
            segment.dataset.model?.trim() ||
            segment
                .getAttribute("aria-label")
                ?.replace(/:\s*\d[\d.,]*\s+requests?\s*$/i, "")
                .trim() ||
            `Model ${index + 1}`
        );
    }

    /**
     * Background color of a segment, used for the legend dot.
     *
     * Falls back to `currentColor` when the computed background is unset or
     * fully transparent, so the dot stays visible instead of disappearing.
     *
     * @param {Element} segment - Usage bar segment.
     * @returns {string} A CSS color value.
     */
    function segmentColor(segment) {
        const color = getComputedStyle(segment).backgroundColor;
        return !color || color === "transparent" || color === "rgba(0, 0, 0, 0)"
            ? "currentColor"
            : color;
    }

    /**
     * Overall usage Ollama reports in the track's aria-label.
     *
     * "Session usage 10.7% used" -> 10.7. This is the share of the total
     * limit already consumed; readSegments() uses it to rescale the
     * per-model segment shares.
     *
     * @param {Element} track - Usage meter track element.
     * @returns {number|null} Overall usage percentage, or null when the
     *   label contains none.
     */
    function overallUsagePercent(track) {
        const match = (track.getAttribute("aria-label") || "").match(
            /(\d+(?:[.,]\d+)?)\s*%/,
        );
        return match ? Number(match[1].replace(",", ".")) : null;
    }

    /**
     * Read every segment of a usage track into a plain record.
     *
     * Ollama exposes each model's usage share only as the segment width in
     * its own HTML, and those widths are shares of the used portion (they
     * sum to 100%). Rescaling them by the overall "X% used" measures every
     * model against the total limit, so the percentages sum to X instead.
     *
     * @param {Element} track - Usage meter track element.
     * @param {number|null} share - Overall usage percentage from
     *   overallUsagePercent(); null when unavailable.
     * @returns {Array<{name: string, requests: number|null, width: string,
     *   percent: number|null, absolute: number|null, color: string}>}
     *   One record per segment, in DOM order. `percent` is the raw share of
     *   the used portion; `absolute` is `percent` rescaled against `share`
     *   (null when either value is unavailable).
     */
    function readSegments(track, share) {
        return [
            .../** @type {NodeListOf<HTMLElement>} */ (
                track.querySelectorAll(SEGMENT)
            ),
        ].map((segment, index) => {
            const width = segment.style.width.trim();
            const sharePercent = percent(width);
            return {
                name: modelName(segment, index),
                requests: requests(segment),
                width,
                percent: sharePercent,
                absolute:
                    sharePercent !== null && share !== null
                        ? (sharePercent * share) / 100
                        : null,
                color: segmentColor(segment),
            };
        });
    }

    /**
     * Format a request count for display, e.g. "1,234 requests".
     *
     * @param {number|null} value - Request count, or null when unknown.
     * @returns {string} Localized count with unit, or "—" when unknown.
     */
    function formatRequests(value) {
        if (value === null) return "—";
        return `${formatNumber.format(value)} ${value === 1 ? "request" : "requests"}`;
    }

    /**
     * Format a rescaled percentage with two decimal places.
     *
     * Nonzero values that round down to "0.00" render as "<0.01%" so tiny
     * shares remain visible.
     *
     * @param {number|null} value - Percentage of the total limit, or null.
     * @returns {string|null} Formatted percentage, or null when unknown.
     */
    function formatAbsolute(value) {
        if (value === null) return null;
        if (value === 0) return "0%";
        const rounded = value.toFixed(2);
        return rounded === "0.00" ? "<0.01%" : `${rounded}%`;
    }

    /**
     * Percentage label for a segment record.
     *
     * Prefers the rescaled percentage; falls back to Ollama's raw width when
     * the overall usage figure is unavailable.
     *
     * @param {{absolute: number|null, width: string}} item - Segment record.
     * @returns {string} Display label, or "—" when nothing is available.
     */
    function usageLabel(item) {
        return formatAbsolute(item.absolute) || item.width || "—";
    }

    /**
     * Find the usage track whose aria-label matches a meter kind.
     *
     * @param {string} kind - Meter kind ("session" or "weekly"), matched
     *   case-insensitively as a regular expression against the aria-label.
     * @param {Element[]} tracks - Candidate tracks.
     * @returns {Element|null} The first matching track, or null.
     */
    function trackForKind(kind, tracks) {
        return (
            tracks.find((track) =>
                new RegExp(kind, "i").test(
                    track.getAttribute("aria-label") || "",
                ),
            ) || null
        );
    }

    /**
     * Append the absolute reset date/time next to each relative reset text.
     *
     * Ollama renders `.local-time[data-time]` elements with relative text
     * ("Resets in 2 hours") that it rewrites in place; the absolute part is
     * appended in parentheses and re-derived whenever the relative text
     * changes, tracked via data attributes on the element itself.
     */
    function enhanceResetTimes() {
        /** @type {NodeListOf<HTMLElement>} */ (
            document.querySelectorAll(".local-time[data-time]")
        ).forEach((time) => {
            const resetAt = new Date(/** @type {string} */ (time.dataset.time));
            if (Number.isNaN(resetAt.getTime())) return;

            const currentText = time.textContent.trim();
            const previousDisplay =
                time.dataset.ollamaUsageEnhancerResetDisplay;
            const relativeTime =
                currentText !== previousDisplay
                    ? currentText
                    : time.dataset.ollamaUsageEnhancerRelativeResetText ||
                      currentText;
            const display = `${relativeTime} (${resetTimeFormatter.format(resetAt)})`;

            if (currentText !== display) time.textContent = display;
            time.dataset.ollamaUsageEnhancerRelativeResetText = relativeTime;
            time.dataset.ollamaUsageEnhancerResetDisplay = display;

            // Remove the hover-only data added by version 1.2.1, without
            // changing the tooltip that Ollama itself provides.
            if (time.title.startsWith("Exact reset time:")) {
                time.removeAttribute("title");
            }
            if (
                time.getAttribute("aria-label")?.includes(". Exact reset time:")
            ) {
                time.removeAttribute("aria-label");
            }
        });
    }

    /**
     * Render or update the "Models used this session" panel.
     *
     * Uses the exact same markup Ollama uses for its native weekly list
     * ("Models used this week"), plus a percentage column. The panel is
     * cached per track, placed right after the meter's reset time when one
     * exists (after the track itself otherwise), and rebuilt from scratch on
     * every call.
     *
     * @param {Element} track - Session usage track.
     * @param {ReturnType<typeof readSegments>} segments - Segment records.
     * @returns {Element} The panel element, tagged with the PANEL marker.
     */
    function renderSessionList(track, segments) {
        let panel = panels.get(track);
        if (!panel) {
            panel = document.createElement("div");
            panel.id = "session-usage-models";
            panel.setAttribute(PANEL, "");
            panel.className = "mt-3 space-y-1.5";
            panels.set(track, panel);
        }

        const meter = track.closest("[data-usage-meter]");
        const resetTime = meter?.nextElementSibling?.matches(
            ".local-time[data-time]",
        )
            ? meter.nextElementSibling
            : null;
        const insertionPoint = resetTime || track;
        if (insertionPoint.nextElementSibling !== panel) {
            insertionPoint.after(panel);
        }
        panel.replaceChildren();
        panel.append(element("div", "text-xs text-neutral-500", SESSION_LIST_LABEL));

        for (const item of segments) {
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
                    formatRequests(item.requests),
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

    /**
     * Locate Ollama's native weekly usage list.
     *
     * Prefers the well-known element id and falls back to the parent of the
     * div whose text equals the weekly list heading.
     *
     * @returns {Element|null} The weekly list container, or null when absent.
     */
    function weeklyUsageList() {
        const byId = document.getElementById(WEEKLY_LIST_ID);
        if (byId) return byId;

        const heading = [...document.querySelectorAll("div.text-xs")].find(
            (node) => node.textContent.trim() === WEEKLY_LIST_LABEL,
        );
        return heading?.parentElement ?? null;
    }

    /**
     * Inject per-model percentages into Ollama's native weekly list.
     *
     * The native list shows request counts but no per-model percentage, so
     * the share Ollama encodes in the meter segments is added as an extra
     * column. Ollama's own request counts are aligned into the same
     * fixed-width column the session list uses, tagged with COUNT_MARK so
     * cleanup can revert the styling. Rows whose model has no matching
     * segment lose the injected column again.
     *
     * @param {Element} track - Weekly usage track (not read directly; the
     *   list is located via weeklyUsageList()).
     * @param {ReturnType<typeof readSegments>} segments - Segment records.
     */
    function enhanceWeeklyList(track, segments) {
        const list = weeklyUsageList();
        if (!list) return;

        const labelsByName = new Map();
        for (const item of segments) {
            if (item.width) labelsByName.set(item.name, usageLabel(item));
        }

        list.querySelectorAll(":scope > div").forEach((row) => {
            const nameSpan = /** @type {HTMLElement} */ (
                row.querySelector("span[title]")
            );
            const name =
                nameSpan?.getAttribute("title")?.trim() ||
                nameSpan?.textContent?.trim();
            if (!name) return;

            const label = labelsByName.get(name);
            let pct = row.querySelector(`[${PCT_MARK}]`);
            const countSpan = [...row.querySelectorAll("span.tabular-nums")].find(
                (span) => !span.hasAttribute(PCT_MARK),
            );

            if (!label) {
                pct?.remove();
                if (countSpan?.hasAttribute(COUNT_MARK)) {
                    countSpan.classList.remove("oue-num");
                    countSpan.removeAttribute(COUNT_MARK);
                }
                return;
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

            if (pct.textContent !== label) pct.textContent = label;
        });
    }

    /**
     * Reconcile the page with the desired enhancements; safe to run often.
     *
     * Outside the bare /settings path, removes every node this script added
     * and reverts the marked spans (cleanup on navigation). Inside, refreshes
     * reset times, rebuilds the session panel from the session track, injects
     * percentages into the weekly list, and drops stale panels. When no
     * aria-label matches, the first track is treated as the session meter and
     * the next one as weekly.
     */
    function refresh() {
        refreshQueued = false;

        if (!/^\/settings\/?$/.test(location.pathname)) {
            document
                .querySelectorAll(`[${PANEL}],[${PCT_MARK}]`)
                .forEach((node) => node.remove());
            document.querySelectorAll(`[${COUNT_MARK}]`).forEach((span) => {
                span.classList.remove("oue-num");
                span.removeAttribute(COUNT_MARK);
            });
            return;
        }

        addStyles();
        enhanceResetTimes();

        const tracks = [...document.querySelectorAll(TRACK)];
        const sessionTrack =
            trackForKind("session", tracks) || tracks[0] || null;
        const weeklyTrack =
            trackForKind("weekly", tracks) ||
            tracks.find((track) => track !== sessionTrack) ||
            null;

        const activePanels = new Set();

        if (sessionTrack) {
            const segments = readSegments(
                sessionTrack,
                overallUsagePercent(sessionTrack),
            );
            if (segments.length) {
                activePanels.add(renderSessionList(sessionTrack, segments));
            }
        }

        if (weeklyTrack) {
            enhanceWeeklyList(
                weeklyTrack,
                readSegments(weeklyTrack, overallUsagePercent(weeklyTrack)),
            );
        }

        document.querySelectorAll(`[${PANEL}]`).forEach((panel) => {
            if (!activePanels.has(panel)) panel.remove();
        });
    }

    /**
     * Queue a single refresh on the next animation frame.
     *
     * Coalesces bursts of mutations into one pass; refresh() clears the flag
     * so later changes queue again.
     */
    function scheduleRefresh() {
        if (refreshQueued) return;
        refreshQueued = true;
        requestAnimationFrame(refresh);
    }

    /**
     * Whether a mutated node belongs to this script's own additions.
     *
     * Lets the observer ignore self-inflicted mutations and avoid feeding
     * back into another refresh.
     *
     * @param {Node} node - Added or removed node.
     * @returns {boolean} True when the node is, or is inside, a panel or
     *   percentage span.
     */
    function isOwnChange(node) {
        return (
            node instanceof Element &&
            (node.hasAttribute(PANEL) ||
                node.hasAttribute(PCT_MARK) ||
                node.closest(`[${PANEL}],[${PCT_MARK}]`) !== null)
        );
    }

    // React only to changes Ollama made: mutations inside this script's own
    // nodes, or batches whose added/removed nodes are all its own, must not
    // schedule another refresh or the observer would loop on itself. The
    // attribute filter lists exactly the attributes the enhancements read.
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
                if (changed.length && changed.every(isOwnChange)) return false;
                return true;
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
            "data-model",
            "data-requests",
            "data-time",
        ],
    });

    // SPA navigation can change the URL and swap content; the observer covers
    // DOM updates, these cover the navigation event itself.
    window.addEventListener("popstate", scheduleRefresh);
    window.addEventListener("hashchange", scheduleRefresh);
    window.navigation?.addEventListener?.("navigate", scheduleRefresh);

    scheduleRefresh();
})();
