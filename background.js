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

function isAliExpressHost(hostname) {
    return /(^|\.)aliexpress\.(com|us)$/i.test(hostname || '');
}

function isAmazonHost(hostname) {
    return /(^|\.)amazon\.com$/i.test(hostname || '');
}

function getSiteFromUrl(url) {
    try {
        const parsed = new URL(url);
        if (isAliExpressHost(parsed.hostname)) {
            return 'aliexpress';
        }
        if (isAmazonHost(parsed.hostname)) {
            return 'amazon';
        }
    } catch (error) {
        return null;
    }

    return null;
}

function getAliExpressHostFromUrl(url) {
    try {
        const parsed = new URL(url);
        return /aliexpress\.us$/i.test(parsed.hostname.replace(/^www\./, '')) ?
            'www.aliexpress.us' : 'www.aliexpress.com';
    } catch (error) {
        return 'www.aliexpress.com';
    }
}

function getSearchKeyFromUrl(url) {
    try {
        const parsed = new URL(url);

        if (isAmazonHost(parsed.hostname)) {
            if (parsed.pathname !== '/s' && !parsed.pathname.startsWith('/s/')) {
                return null;
            }
            return normalizeSearchKey(parsed.searchParams.get('k') || '');
        }

        if (isAliExpressHost(parsed.hostname)) {
            const searchText = parsed.searchParams.get('SearchText') ||
                parsed.searchParams.get('searchText') ||
                parsed.searchParams.get('q');
            if (searchText) {
                return normalizeSearchKey(searchText);
            }

            const wholesale = parsed.pathname.match(/\/w\/wholesale-(.+)\.html/i);
            if (wholesale) {
                return normalizeSearchKey(wholesale[1].replace(/-/g, ' '));
            }

            if (/\/wholesale/i.test(parsed.pathname)) {
                return '';
            }

            return null;
        }
    } catch (error) {
        return null;
    }

    return null;
}

function isSearchUrl(url) {
    return getSearchKeyFromUrl(url) !== null;
}

function buildSearchUrl(settings) {
    const term = settings.searchTerm || '';
    if (settings.targetSite === 'aliexpress') {
        const host = settings.aliexpressHost === 'www.aliexpress.us' ?
            'www.aliexpress.us' : 'www.aliexpress.com';
        const slug = term
            .replace(/[^\w\s-]/g, ' ')
            .trim()
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-') || 'search';
        return `https://${host}/w/wholesale-${slug}.html?g=y&SearchText=${encodeURIComponent(term)}`;
    }

    return `https://www.amazon.com/s?k=${encodeURIComponent(term)}`;
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
        console.error('Exact Search: could not reach search tab', error);
    }
}

function storeFilterState(tabId, settings, searchKey, callback) {
    chrome.storage.local.set({
        filterEnabled: true,
        activeFilterTabId: tabId,
        activeFilterAmazonKey: normalizeSearchKey(searchKey || settings.searchTerm || ''),
        targetSite: settings.targetSite || 'amazon',
        aliexpressHost: settings.aliexpressHost || 'www.aliexpress.com',
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
        const searchUrl = buildSearchUrl(settings);

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
            const detectedSite = getSiteFromUrl(tab?.url || '');
            if (detectedSite) {
                settings.targetSite = detectedSite;
            }
            if (detectedSite === 'aliexpress') {
                settings.aliexpressHost = getAliExpressHostFromUrl(tab.url);
            }

            const searchKey = getSearchKeyFromUrl(tab?.url || '') || settings.searchTerm;
            storeFilterState(request.tabId, settings, searchKey, async () => {
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

            if (!isSearchUrl(url)) {
                endFilterSession(() => {
                    notifyTabFilterEnded(tabId);
                });
                return;
            }

            const currentKey = getSearchKeyFromUrl(url);
            const sessionKey = normalizeSearchKey(data.activeFilterAmazonKey || '');
            if (sessionKey && currentKey && currentKey !== sessionKey) {
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
