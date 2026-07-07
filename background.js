function buildFilterMessage(settings) {
    return {
        action: 'filterResults',
        searchTerm: settings.searchTerm,
        caseSensitive: settings.caseSensitive ?? false,
        highlightMatch: settings.highlightMatch ?? true,
        sortMode: settings.sortMode || 'amazon'
    };
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

function storeFilterState(tabId, settings, callback) {
    chrome.storage.local.set({
        filterEnabled: true,
        activeFilterTabId: tabId,
        searchTerm: settings.searchTerm,
        caseSensitive: settings.caseSensitive ?? false,
        highlightMatch: settings.highlightMatch ?? true,
        sortMode: settings.sortMode || 'amazon'
    }, callback);
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

    // Popup asks background to open the search tab so the flow survives the popup closing.
    if (request.action === 'searchAndFilter') {
        const settings = request.settings || {};
        const searchUrl = `https://www.amazon.com/s?k=${encodeURIComponent(settings.searchTerm)}`;

        chrome.tabs.create({ url: searchUrl }, (tab) => {
            storeFilterState(tab.id, settings, () => {
                sendResponse({ ok: true });
            });
        });
        return true;
    }

    if (request.action === 'filterCurrentTab') {
        const settings = request.settings || {};
        storeFilterState(request.tabId, settings, async () => {
            await sendFilterToTab(request.tabId, settings);
            sendResponse({ ok: true });
        });
        return true;
    }

    if (request.action === 'resetAndReload') {
        chrome.storage.local.set({ filterEnabled: false, activeFilterTabId: null }, () => {
            if (request.tabId) {
                chrome.tabs.reload(request.tabId, { bypassCache: true });
            }
            sendResponse({ ok: true });
        });
        return true;
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') {
        return;
    }

    if (!tab.url || !tab.url.includes('amazon.com/s')) {
        return;
    }

    chrome.storage.local.get(
        ['filterEnabled', 'activeFilterTabId', 'searchTerm', 'caseSensitive', 'highlightMatch', 'sortMode'],
        (data) => {
            if (!data.filterEnabled || data.activeFilterTabId !== tabId || !data.searchTerm) {
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
