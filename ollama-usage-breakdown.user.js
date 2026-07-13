// ==UserScript==
// @name         Ollama Usage Breakdown
// @namespace    https://github.com/srnoob2570
// @version      1.2.3
// @description  Shows a clearer Ollama Cloud usage bar, per-model breakdown, and inline exact reset times.
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

    function addStyles() {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
      [${PANEL}] {
        width: 100%;
        margin-top: .65rem;
        padding: .75rem;
        box-sizing: border-box;
        color: inherit;
        font: inherit;
        border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
        border-radius: .75rem;
        background: color-mix(in srgb, currentColor 4%, transparent);
      }
      [${PANEL}] * { box-sizing: border-box; }
      [${PANEL}] .oue-head,
      [${PANEL}] summary,
      [${PANEL}] .oue-row,
      [${PANEL}] .oue-model {
        display: flex;
        align-items: center;
      }
      [${PANEL}] .oue-head,
      [${PANEL}] summary {
        justify-content: space-between;
        gap: .75rem;
      }
      [${PANEL}] .oue-title { font-size: .875rem; font-weight: 600; }
      [${PANEL}] .oue-meta,
      [${PANEL}] .oue-count { font-size: .75rem; opacity: .68; }
      [${PANEL}] .oue-bar {
        display: flex;
        width: 100%;
        height: .75rem;
        margin-top: .55rem;
        overflow: hidden;
        border-radius: 999px;
        background: color-mix(in srgb, currentColor 13%, transparent);
      }
      [${PANEL}] .oue-segment { height: 100%; flex: 0 0 auto; }
      [${PANEL}] .oue-empty {
        height: auto;
        min-height: 1.35rem;
        align-items: center;
        justify-content: center;
        font-size: .7rem;
        opacity: .7;
      }
      [${PANEL}] details { margin-top: .6rem; }
      [${PANEL}] summary {
        cursor: pointer;
        font-size: .8rem;
        font-weight: 600;
        list-style: none;
      }
      [${PANEL}] summary::-webkit-details-marker { display: none; }
      [${PANEL}] .oue-summary-end {
        display: inline-flex;
        align-items: center;
        gap: .5rem;
      }
      [${PANEL}] .oue-toggle {
        width: .5rem;
        height: .5rem;
        flex: 0 0 auto;
        border-right: 1.5px solid currentColor;
        border-bottom: 1.5px solid currentColor;
        opacity: .7;
        transform: rotate(45deg) translate(-1px, -1px);
        transition: transform 120ms ease;
      }
      [${PANEL}] details:not([open]) .oue-toggle {
        transform: rotate(-45deg) translate(1px, 1px);
      }
      [${PANEL}] .oue-list { display: grid; gap: .15rem; margin-top: .45rem; }
      [${PANEL}] .oue-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto auto;
        gap: .65rem;
        min-height: 2rem;
        padding: .35rem .45rem;
        border-radius: .5rem;
        font-size: .76rem;
      }
      [${PANEL}] .oue-row:hover {
        background: color-mix(in srgb, currentColor 6%, transparent);
      }
      [${PANEL}] .oue-model { min-width: 0; gap: .5rem; }
      [${PANEL}] .oue-dot {
        width: .62rem;
        height: .62rem;
        flex: 0 0 auto;
        border-radius: 50%;
      }
      [${PANEL}] .oue-name {
        overflow: hidden;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      [${PANEL}] .oue-value { white-space: nowrap; font-variant-numeric: tabular-nums; }
      [${PANEL}] .oue-width { min-width: 3.4rem; text-align: right; opacity: .7; }
      @media (max-width: 540px) {
        [${PANEL}] .oue-head { align-items: flex-start; flex-direction: column; gap: .2rem; }
        [${PANEL}] .oue-row { grid-template-columns: minmax(0, 1fr) auto; }
        [${PANEL}] .oue-width { grid-column: 2; }
      }
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

    function readSegments(track) {
        return [...track.querySelectorAll(SEGMENT)]
            .map((segment, index) => {
                const width = segment.style.width.trim();
                return {
                    name: modelName(segment, index),
                    requests: requests(segment),
                    width,
                    percent: percent(width),
                    color: segmentColor(segment),
                };
            })
            .sort(
                (a, b) =>
                    (b.percent ?? -1) - (a.percent ?? -1) ||
                    (b.requests ?? -1) - (a.requests ?? -1) ||
                    a.name.localeCompare(b.name),
            );
    }

    function readMetadata(track) {
        const label = track.getAttribute("aria-label")?.trim() || "";
        const percentage =
            label.match(/\d+(?:[.,]\d+)?\s*%/)?.[0]?.replace(/\s/g, "") || null;
        const type = percentage
            ? label
                  .slice(0, label.indexOf(percentage.replace("%", "")))
                  .replace(/[\s,:;–—-]+$/, "")
                  .trim()
            : label;

        return {
            type: type || "Cloud usage",
            percentage,
        };
    }

    function formatRequests(value) {
        if (value === null) return "Request count unavailable";
        return `${formatNumber.format(value)} ${value === 1 ? "request" : "requests"}`;
    }

    function tooltip(segment) {
        return [segment.name, formatRequests(segment.requests), segment.width]
            .filter(Boolean)
            .join(" · ");
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

    function render(track, segments) {
        let panel = panels.get(track);
        const wasOpen = panel?.querySelector("details")?.open ?? false;

        if (!panel) {
            panel = document.createElement("section");
            panel.setAttribute(PANEL, "");
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

        const metadata = readMetadata(track);
        const total = segments.reduce(
            (sum, item) => sum + (item.requests ?? 0),
            0,
        );
        const head = element("div", "oue-head");
        const title = element("div", "oue-title", metadata.type);
        const meta = element(
            "div",
            "oue-meta",
            [
                metadata.percentage &&
                    `${metadata.percentage} reported by Ollama`,
                `Detected total: ${formatRequests(total)}`,
            ]
                .filter(Boolean)
                .join(" · "),
        );
        head.append(title, meta);

        const bar = element("div", "oue-bar");
        bar.setAttribute("role", "img");
        bar.setAttribute(
            "aria-label",
            `Model distribution: ${segments.map(tooltip).join("; ")}`,
        );

        for (const item of segments.filter(({ width }) => width)) {
            const part = element("span", "oue-segment");
            const label = tooltip(item);
            part.style.width = item.width;
            part.style.backgroundColor = item.color;
            if ((item.percent ?? 0) > 0) part.style.minWidth = "2px";
            part.title = label;
            part.setAttribute("aria-label", label);
            bar.append(part);
        }

        if (!bar.children.length) {
            bar.classList.add("oue-empty");
            bar.textContent = "No usable segment widths found";
        }

        const details = element("details");
        details.open = wasOpen;
        const summary = element("summary");
        const summaryEnd = element("span", "oue-summary-end");
        const count = element(
            "span",
            "oue-count",
            `${segments.length} ${segments.length === 1 ? "model" : "models"}`,
        );
        const toggle = element("span", "oue-toggle");
        toggle.setAttribute("aria-hidden", "true");
        summaryEnd.append(count, toggle);
        summary.append(element("span", "", "Breakdown by model"), summaryEnd);

        const list = element("div", "oue-list");
        for (const item of segments) {
            const row = element("div", "oue-row");
            const model = element("div", "oue-model");
            const dot = element("span", "oue-dot");
            const name = element("span", "oue-name", item.name);

            dot.style.backgroundColor = item.color;
            name.title = item.name;
            model.append(dot, name);
            row.append(
                model,
                element(
                    "span",
                    "oue-value",
                    item.requests === null
                        ? "— requests"
                        : formatRequests(item.requests),
                ),
                element("span", "oue-value oue-width", item.width || "—"),
            );
            list.append(row);
        }

        details.append(summary, list);
        panel.append(head, bar, details);
        return panel;
    }

    function refresh() {
        refreshQueued = false;

        if (!/^\/settings\/?$/.test(location.pathname)) {
            document
                .querySelectorAll(`[${PANEL}]`)
                .forEach((panel) => panel.remove());
            return;
        }

        addStyles();
        enhanceResetTimes();
        const activePanels = new Set();

        document.querySelectorAll(TRACK).forEach((track) => {
            const segments = readSegments(track);
            if (segments.length) activePanels.add(render(track, segments));
        });

        document.querySelectorAll(`[${PANEL}]`).forEach((panel) => {
            if (!activePanels.has(panel)) panel.remove();
        });
    }

    function scheduleRefresh() {
        if (refreshQueued) return;
        refreshQueued = true;
        requestAnimationFrame(refresh);
    }

    new MutationObserver((mutations) => {
        const externalChange = mutations.some(
            ({ target }) =>
                !(target instanceof Element && target.closest(`[${PANEL}]`)),
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
