function buildFilterMessage(settings) {
    return {
        action: 'filterResults',
        searchTerm: settings.searchTerm,
        caseSensitive: settings.caseSensitive ?? false,
        highlightMatch: settings.highlightMatch ?? true,
        sortMode: settings.sortMode || 'amazon'
    };
}

function normalizeSearchKey(value) {
    if (!value) {
        return '';
    }

    return decodeURIComponent(String(value).replace(/\+/g, ' '))
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function getAmazonSearchKeyFromUrl(url) {
    try {
        const parsed = new URL(url);
        if (!/amazon\.com/i.test(parsed.hostname)) {
            return null;
        }

        if (parsed.pathname !== '/s' && !parsed.pathname.startsWith('/s/')) {
            return null;
        }

        return normalizeSearchKey(parsed.searchParams.get('k') || '');
    } catch (error) {
        return null;
    }
}

function isAmazonSearchUrl(url) {
    return getAmazonSearchKeyFromUrl(url) !== null;
}

async function sendFilterToTab(tabId, settings) {
    const message = buildFilterMessage(settings);

    try {
        await chrome.tabs.sendMessage(tabId, message);
        return;
    } catch (error) {
        // Content script may not be loaded yet — inject and retry.
    }

    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js']
        });
        await chrome.scripting.insertCSS({
            target: { tabId },
            files: ['styles.css']
        });
        await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
        console.error('Exact Search: could not reach Amazon tab', error);
    }
}

function storeFilterState(tabId, settings, amazonKey, callback) {
    chrome.storage.local.set({
        filterEnabled: true,
        activeFilterTabId: tabId,
        activeFilterAmazonKey: normalizeSearchKey(amazonKey || settings.searchTerm || ''),
        searchTerm: settings.searchTerm,
        caseSensitive: settings.caseSensitive ?? false,
        highlightMatch: settings.highlightMatch ?? true,
        sortMode: settings.sortMode || 'amazon'
    }, callback);
}

function endFilterSession(callback) {
    chrome.storage.local.set({
        filterEnabled: false,
        activeFilterTabId: null,
        activeFilterAmazonKey: null
    }, callback);
}

function notifyTabFilterEnded(tabId) {
    chrome.tabs.sendMessage(tabId, { action: 'clearFilter' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getTabFilterState') {
        chrome.storage.local.get(
            ['filterEnabled', 'activeFilterTabId', 'searchTerm', 'caseSensitive', 'highlightMatch', 'sortMode'],
            (data) => {
                sendResponse({
                    shouldFilter: !!(
                        data.filterEnabled &&
                        sender.tab &&
                        sender.tab.id === data.activeFilterTabId
                    ),
                    searchTerm: data.searchTerm || '',
                    caseSensitive: data.caseSensitive ?? false,
                    highlightMatch: data.highlightMatch ?? true,
                    sortMode: data.sortMode || 'amazon'
                });
            }
        );
        return true;
    }

    if (request.action === 'searchAndFilter') {
        const settings = request.settings || {};
        const searchUrl = `https://www.amazon.com/s?k=${encodeURIComponent(settings.searchTerm)}`;

        chrome.tabs.create({ url: searchUrl }, (tab) => {
            storeFilterState(tab.id, settings, settings.searchTerm, () => {
                sendResponse({ ok: true });
            });
        });
        return true;
    }

    if (request.action === 'filterCurrentTab') {
        const settings = request.settings || {};

        chrome.tabs.get(request.tabId, (tab) => {
            const amazonKey = getAmazonSearchKeyFromUrl(tab?.url || '') || settings.searchTerm;
            storeFilterState(request.tabId, settings, amazonKey, async () => {
                await sendFilterToTab(request.tabId, settings);
                sendResponse({ ok: true });
            });
        });
        return true;
    }

    if (request.action === 'endFilterSession') {
        const tabId = request.tabId || (sender.tab && sender.tab.id);

        endFilterSession(() => {
            if (tabId) {
                notifyTabFilterEnded(tabId);
            }
            sendResponse({ ok: true });
        });
        return true;
    }

    if (request.action === 'resetAndReload') {
        endFilterSession(() => {
            if (request.tabId) {
                chrome.tabs.reload(request.tabId, { bypassCache: true });
            }
            sendResponse({ ok: true });
        });
        return true;
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo.url && changeInfo.status !== 'complete') {
        return;
    }

    chrome.storage.local.get(
        [
            'filterEnabled',
            'activeFilterTabId',
            'activeFilterAmazonKey',
            'searchTerm',
            'caseSensitive',
            'highlightMatch',
            'sortMode'
        ],
        (data) => {
            if (!data.filterEnabled || data.activeFilterTabId !== tabId) {
                return;
            }

            const url = tab.url || changeInfo.url || '';
            if (!url) {
                return;
            }

            // Left Amazon search results (cart, product page, home, etc.)
            if (!isAmazonSearchUrl(url)) {
                endFilterSession(() => {
                    notifyTabFilterEnded(tabId);
                });
                return;
            }

            // Still on /s, but Amazon search query changed (typed a new search in Amazon's bar)
            const currentKey = getAmazonSearchKeyFromUrl(url);
            const sessionKey = normalizeSearchKey(data.activeFilterAmazonKey || '');
            if (sessionKey && currentKey !== sessionKey) {
                endFilterSession(() => {
                    notifyTabFilterEnded(tabId);
                });
                return;
            }

            if (changeInfo.status !== 'complete') {
                return;
            }

            if (!data.searchTerm) {
                return;
            }

            sendFilterToTab(tabId, {
                searchTerm: data.searchTerm,
                caseSensitive: data.caseSensitive,
                highlightMatch: data.highlightMatch,
                sortMode: data.sortMode
            });
        }
    );
});
