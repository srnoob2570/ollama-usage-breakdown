// ==UserScript==
// @name         Ollama Usage Breakdown
// @namespace    https://github.com/srnoob2570
// @version      1.3.2
// @description  Adds an Ollama-style per-model session breakdown and inline per-model usage percentages.
// @author       srnoob2570
// @match        https://ollama.com/settings*
// @homepageURL  https://github.com/srnoob2570/ollama-usage-breakdown
// @supportURL   https://github.com/srnoob2570/ollama-usage-breakdown/issues
// @updateURL    https://raw.githubusercontent.com/srnoob2570/ollama-usage-breakdown/main/ollama-usage-breakdown.user.js
// @downloadURL  https://raw.githubusercontent.com/srnoob2570/ollama-usage-breakdown/main/ollama-usage-breakdown.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
    "use strict";

    const TRACK = "[data-usage-track]";
    const SEGMENT = "[data-usage-segment]";
    const PANEL = "data-ollama-usage-enhancer";
    const WEEKLY_LIST_ID = "weekly-usage-models";
    const WEEKLY_LIST_LABEL = "Models used this week";
    const SESSION_LIST_LABEL = "Models used this session";
    const PCT_MARK = "data-oue-pct";
    const COUNT_MARK = "data-oue-num";
    const STYLE_ID = "ollama-usage-enhancer-styles";
    const panels = new WeakMap();
    const formatNumber = new Intl.NumberFormat(
        document.documentElement.lang || undefined,
    );
    const resetTimeFormatter = new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });

    let refreshQueued = false;

    // Fixed-width, right-aligned numeric columns keep the request counts and
    // percentages lined up in both breakdowns (Ollama ships a compiled
    // Tailwind build, so arbitrary utilities like min-w-[5.5rem] are not
    // guaranteed to exist and a small style block is the safe route).
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

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function percent(value) {
        const match = value?.match(/(-?\d+(?:[.,]\d+)?)\s*%/);
        return match ? Number(match[1].replace(",", ".")) : null;
    }

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

    function segmentColor(segment) {
        const color = getComputedStyle(segment).backgroundColor;
        return !color || color === "transparent" || color === "rgba(0, 0, 0, 0)"
            ? "currentColor"
            : color;
    }

    // Overall usage reported by Ollama in the track label ("Session usage
    // 10.7% used" -> 10.7), used to rescale the per-model segment shares.
    function overallUsagePercent(track) {
        const match = (track.getAttribute("aria-label") || "").match(
            /(\d+(?:[.,]\d+)?)\s*%/,
        );
        return match ? Number(match[1].replace(",", ".")) : null;
    }

    // Ollama exposes each model's usage share only as the segment width in
    // its own HTML, and those widths are shares of the used portion (they
    // sum to 100%). Rescaling them by the overall "X% used" measures every
    // model against the total limit, so the percentages sum to X instead.
    function readSegments(track, share) {
        return [...track.querySelectorAll(SEGMENT)].map((segment, index) => {
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

    function formatRequests(value) {
        if (value === null) return "—";
        return `${formatNumber.format(value)} ${value === 1 ? "request" : "requests"}`;
    }

    function formatAbsolute(value) {
        if (value === null) return null;
        if (value === 0) return "0%";
        const rounded = value.toFixed(2);
        return rounded === "0.00" ? "<0.01%" : `${rounded}%`;
    }

    // Prefer the rescaled percentage; fall back to Ollama's raw width when
    // the overall usage figure is unavailable.
    function usageLabel(item) {
        return formatAbsolute(item.absolute) || item.width || "—";
    }

    function trackForKind(kind, tracks) {
        return (
            tracks.find((track) =>
                new RegExp(kind, "i").test(
                    track.getAttribute("aria-label") || "",
                ),
            ) || null
        );
    }

    function enhanceResetTimes() {
        document.querySelectorAll(".local-time[data-time]").forEach((time) => {
            const resetAt = new Date(time.dataset.time);
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

    // Session breakdown rendered with the exact same markup Ollama uses for
    // its native weekly list ("Models used this week"), plus a percentage.
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

    function weeklyUsageList() {
        const byId = document.getElementById(WEEKLY_LIST_ID);
        if (byId) return byId;

        const heading = [...document.querySelectorAll("div.text-xs")].find(
            (node) => node.textContent.trim() === WEEKLY_LIST_LABEL,
        );
        return heading?.parentElement ?? null;
    }

    // Ollama's native weekly list shows request counts but no per-model
    // percentage, so inject the share Ollama encodes in the meter segments.
    function enhanceWeeklyList(track, segments) {
        const list = weeklyUsageList();
        if (!list) return;

        const labelsByName = new Map();
        for (const item of segments) {
            if (item.width) labelsByName.set(item.name, usageLabel(item));
        }

        list.querySelectorAll(":scope > div").forEach((row) => {
            const nameSpan = row.querySelector("span[title]");
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

            // Align Ollama's request counts into the same fixed column the
            // session list uses; the marker allows reverting it on cleanup.
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

    function scheduleRefresh() {
        if (refreshQueued) return;
        refreshQueued = true;
        requestAnimationFrame(refresh);
    }

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

    window.addEventListener("popstate", scheduleRefresh);
    window.addEventListener("hashchange", scheduleRefresh);
    window.navigation?.addEventListener?.("navigate", scheduleRefresh);

    scheduleRefresh();
})();
