/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { BrowserContext } from "@trios/shared/schemas/browser-context";

const CDP_UNAVAILABLE = "CDP unavailable";

/**
 * Helper to create a method that throws a descriptive error.
 * Every browser-dependent tool gets a clear message instead of
 * a cryptic "X is not a function" runtime crash.
 */
function unavailable(name: string): (..._: unknown[]) => never {
	const throwUnavailable = () => {
		throw new Error(
			`${CDP_UNAVAILABLE}: ${name}() requires a connected Chrome/CDP browser. ` +
				`Start Chrome with --remote-debugging-port or set trios_CDP_PORT.`,
		);
	};
	return throwUnavailable;
}

/**
 * Fallback browser implementation when CDP is unavailable.
 * Allows the HTTP server (including /chat, /a2a, git tools) to boot
 * in a degraded mode. Browser-dependent tools throw descriptive errors
 * instead of crashing with "X is not a function".
 */
export class NullBrowser {
	isCdpConnected(): boolean {
		return false;
	}

	async resolveTabIds(_tabIds: number[]): Promise<Map<number, number>> {
		throw new Error(
			`${CDP_UNAVAILABLE}: resolveTabIds() requires a connected Chrome/CDP browser.`,
		);
	}

	async newPage(): Promise<number> {
		throw new Error(
			`${CDP_UNAVAILABLE}: newPage() requires a connected Chrome/CDP browser.`,
		);
	}

	async listPages(): Promise<Array<{ pageId: number; windowId?: number }>> {
		// Return empty — tools like list_pages should still work, just show no pages.
		return [];
	}

	async closePage(_pageId: number): Promise<void> {
		throw new Error(
			`${CDP_UNAVAILABLE}: closePage() requires a connected Chrome/CDP browser.`,
		);
	}

	// Some callers pass browserContext through; keep signature-compatible.
	async getBrowserContext(
		ctx?: BrowserContext,
	): Promise<BrowserContext | undefined> {
		return ctx;
	}

	// --- Navigation ---
	readonly getActivePage = unavailable("getActivePage");
	readonly goto = unavailable("goto");
	readonly goBack = unavailable("goBack");
	readonly goForward = unavailable("goForward");
	readonly reload = unavailable("reload");

	// --- Page management ---
	readonly showPage = unavailable("showPage");
	readonly movePage = unavailable("movePage");
	readonly waitFor = unavailable("waitFor");

	// --- Input ---
	readonly click = unavailable("click");
	readonly clickAt = unavailable("clickAt");
	readonly hover = unavailable("hover");
	readonly hoverAt = unavailable("hoverAt");
	readonly fill = unavailable("fill");
	readonly typeAt = unavailable("typeAt");
	readonly pressKey = unavailable("pressKey");
	readonly drag = unavailable("drag");
	readonly dragAt = unavailable("dragAt");
	readonly scroll = unavailable("scroll");
	readonly handleDialog = unavailable("handleDialog");
	readonly focus = unavailable("focus");
	readonly check = unavailable("check");
	readonly uncheck = unavailable("uncheck");
	readonly uploadFile = unavailable("uploadFile");
	readonly selectOption = unavailable("selectOption");

	// --- Snapshot / DOM ---
	readonly snapshot = unavailable("snapshot");
	readonly enhancedSnapshot = unavailable("enhancedSnapshot");
	readonly contentAsMarkdown = unavailable("contentAsMarkdown");
	readonly screenshot = unavailable("screenshot");
	readonly getPageLinks = unavailable("getPageLinks");
	readonly getDom = unavailable("getDom");
	readonly searchDom = unavailable("searchDom");
	readonly evaluate = unavailable("evaluate");

	// --- Windows ---
	readonly listWindows = unavailable("listWindows");
	readonly createWindow = unavailable("createWindow");
	readonly closeWindow = unavailable("closeWindow");
	readonly activateWindow = unavailable("activateWindow");

	// --- History ---
	readonly searchHistory = unavailable("searchHistory");
	readonly getRecentHistory = unavailable("getRecentHistory");
	readonly deleteHistoryUrl = unavailable("deleteHistoryUrl");
	readonly deleteHistoryRange = unavailable("deleteHistoryRange");

	// --- Bookmarks ---
	readonly getBookmarks = unavailable("getBookmarks");
	readonly createBookmark = unavailable("createBookmark");
	readonly removeBookmark = unavailable("removeBookmark");
	readonly updateBookmark = unavailable("updateBookmark");
	readonly moveBookmark = unavailable("moveBookmark");
	readonly searchBookmarks = unavailable("searchBookmarks");

	// --- Console ---
	readonly getConsoleLogs = unavailable("getConsoleLogs");

	// --- Tab groups ---
	readonly listTabGroups = unavailable("listTabGroups");
	readonly groupTabs = unavailable("groupTabs");
	readonly updateTabGroup = unavailable("updateTabGroup");
	readonly ungroupTabs = unavailable("ungroupTabs");
	readonly closeTabGroup = unavailable("closeTabGroup");

	// --- Page actions ---
	readonly printToPDF = unavailable("printToPDF");
	readonly downloadViaClick = unavailable("downloadViaClick");

	// --- ACL ---
	readonly highlightBlockedElement = unavailable("highlightBlockedElement");
	readonly getTabIdForPage = unavailable("getTabIdForPage");
}
